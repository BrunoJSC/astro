import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Structural checks on the CQL, runnable without a database.
 *
 * These exist because the CQL is the one part of this package that nothing
 * else validates: Biome does not parse it, tsc does not see it, and the unit
 * tests talk to a fake client that happily accepts a query naming a table
 * which does not exist. A whole CREATE TABLE was once deleted by a bad edit
 * and the entire pipeline stayed green.
 *
 * `scripts/validate.sh` is still the real proof -- it applies the schema to a
 * live node. This is the cheap guard that runs on every commit in between.
 */

const COMMENT = /--.*$/u;
const CREATE_TABLE =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\n\)/gu;
const TRAILING_COMMA = /,$/u;
const PRIMARY_KEY_LINE = /^PRIMARY\s+KEY\s*\((.*)\)$/iu;
const GROUPED_PARTITION = /^\((.*?)\)\s*(?:,\s*(.*))?$/u;
const COLUMN_LINE = /^(\w+)\s+\S/u;
const INLINE_PRIMARY_KEY = /PRIMARY\s+KEY/iu;
const TABLE_REF = /\b(?:FROM|INTO|UPDATE)\s+(\w+)/gu;
const INSERT_COLUMNS = /INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)/gu;

const CQL_DIR = join(import.meta.dir, "../../cql");
const SRC_DIR = join(import.meta.dir, "../../src");

interface Table {
  clustering: string[];
  columns: Set<string>;
  partitionKey: string[];
}

/** Strips `--` comments so a commented-out table is not read as real. */
function uncomment(cql: string): string {
  return cql
    .split("\n")
    .map((line) => line.replace(COMMENT, ""))
    .join("\n");
}

function parseTables(): Map<string, Table> {
  const tables = new Map<string, Table>();

  for (const file of readdirSync(CQL_DIR).filter((f) => f.endsWith(".cql"))) {
    const body = uncomment(readFileSync(join(CQL_DIR, file), "utf8"));
    for (const match of body.matchAll(CREATE_TABLE)) {
      const [, name, inner] = match;
      if (!(name && inner)) {
        continue;
      }

      const columns = new Set<string>();
      let partitionKey: string[] = [];
      const clustering: string[] = [];

      for (const rawLine of inner.split("\n")) {
        const line = rawLine.trim().replace(TRAILING_COMMA, "");
        if (!line) {
          continue;
        }

        const pk = line.match(PRIMARY_KEY_LINE);
        if (pk?.[1]) {
          const spec = pk[1].trim();
          const grouped = spec.match(GROUPED_PARTITION);
          if (grouped) {
            partitionKey = grouped[1]?.split(",").map((c) => c.trim()) ?? [];
            if (grouped[2]) {
              clustering.push(...grouped[2].split(",").map((c) => c.trim()));
            }
          } else {
            const parts = spec.split(",").map((c) => c.trim());
            partitionKey = parts.slice(0, 1);
            clustering.push(...parts.slice(1));
          }
          continue;
        }

        const column = line.match(COLUMN_LINE);
        if (column?.[1] && column[1].toUpperCase() !== "PRIMARY") {
          columns.add(column[1]);
          // `id timeuuid PRIMARY KEY` declares the partition key inline.
          if (INLINE_PRIMARY_KEY.test(line)) {
            partitionKey = [column[1]];
          }
        }
      }

      tables.set(name, { clustering, columns, partitionKey });
    }
  }

  return tables;
}

function sourceFiles(): { name: string; body: string }[] {
  return readdirSync(SRC_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((name) => ({ body: readFileSync(join(SRC_DIR, name), "utf8"), name }));
}

const TABLES = parseTables();

describe("cql schema", () => {
  it("declares every table the wrappers were written against", () => {
    // The regression guard: a deleted CREATE TABLE shows up here immediately.
    expect([...TABLES.keys()].sort()).toEqual([
      "audit_logs_by_guild",
      "direct_messages",
      "mentions_by_message",
      "mentions_by_user",
      "messages_by_channel",
      "moderation_logs_by_guild",
      "reactions_by_message",
    ]);
  });

  it("gives every table a partition key", () => {
    for (const [name, table] of TABLES) {
      expect(
        table.partitionKey.length,
        `${name} has no partition key`
      ).toBeGreaterThan(0);
    }
  });

  it("keeps every key column inside the column list", () => {
    for (const [name, table] of TABLES) {
      for (const key of [...table.partitionKey, ...table.clustering]) {
        expect(
          table.columns.has(key),
          `${name}: key column "${key}" undeclared`
        ).toBe(true);
      }
    }
  });

  it("bucketed tables carry bucket_year_month in the partition key", () => {
    for (const [name, table] of TABLES) {
      if (table.columns.has("bucket_year_month")) {
        expect(
          table.partitionKey,
          `${name} buckets outside the partition key`
        ).toContain("bucket_year_month");
      }
    }
  });
});

describe("reactions_by_message", () => {
  const table = TABLES.get("reactions_by_message");

  it("identifies the emoji with exactly one clustering column", () => {
    // Two nullable emoji columns in the key would reject every insert:
    // Cassandra forbids null in any primary key column. See the comment in
    // 004, and the live assertion in scripts/validate.sh.
    expect(table?.clustering).toEqual(["emoji_key", "user_id"]);
    expect(table?.clustering).not.toContain("custom_emoji_id");
  });

  it("keeps custom_emoji_id as a regular column, where null is legal", () => {
    expect(table?.columns.has("custom_emoji_id")).toBe(true);
    expect(table?.partitionKey).toEqual(["message_id"]);
  });

  it("is not bucketed", () => {
    // Reactions are bounded by audience, not by time.
    expect(table?.columns.has("bucket_year_month")).toBe(false);
  });
});

describe("wrappers match the schema", () => {
  it("only query tables that exist", () => {
    for (const { body, name } of sourceFiles()) {
      for (const [, table] of body.matchAll(TABLE_REF)) {
        if (table && !table.startsWith("system")) {
          expect(
            TABLES.has(table),
            `${name} queries unknown table "${table}"`
          ).toBe(true);
        }
      }
    }
  });

  it("only insert columns that exist", () => {
    for (const { body, name } of sourceFiles()) {
      for (const [, table, columnList] of body.matchAll(INSERT_COLUMNS)) {
        const declared = TABLES.get(table ?? "");
        if (!(declared && columnList)) {
          continue;
        }
        for (const column of columnList.split(",").map((c) => c.trim())) {
          if (column) {
            expect(
              declared.columns.has(column),
              `${name}: ${table} has no column "${column}"`
            ).toBe(true);
          }
        }
      }
    }
  });
});
