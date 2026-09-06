/**
 * `bun run auth:generate`
 *
 * Runs the Better Auth CLI, then rewrites `@repo/db`'s schema files from its
 * output. The CLI alone is not enough: it emits one flat file of plain
 * `timestamp()` columns with no composite indexes, and it has no option for
 * any of that -- there is no `withTimezone` setting anywhere in
 * `@better-auth/cli`. Running it directly against the schema would silently
 * revert four deliberate decisions.
 *
 * So the CLI output is treated as input. This script owns the schema files:
 * it applies the transforms below and splits the result per table, which makes
 * regeneration idempotent -- run it twice and the second run changes nothing.
 *
 * Transforms:
 *   1. `timestamp(x)`            -> `timestamp(x, { withTimezone: true })`
 *   2. `text("id").primaryKey()` -> `.$defaultFn(newId)` appended
 *   3. composite indexes appended per table
 *   4. one file per table, plus relations
 *
 * Edit THIS FILE, not the generated schema files.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { $ } from "bun";

const TIMESTAMP_PATTERN = /timestamp\("([a-z_]+)"\)/g;
const PRIMARY_KEY_PATTERN = /text\("id"\)\.primaryKey\(\)/g;
const USER_REFERENCE_PATTERN = /references\(\(\) => user\./;
const TRAILING_COMMA_PATTERN = /,$/;

const AUTH_ROOT = join(import.meta.dir, "..");
const DB_SCHEMA = join(AUTH_ROOT, "../db/src/schema");
const REFERENCE = join(DB_SCHEMA, "generated/better-auth.ts");

/** Per-table output: file name, prose, and the indexes the CLI does not emit. */
const TABLES = {
  account: {
    doc: `Credentials and linked providers, one row per (providerId, accountId).

\`password\` holds the Argon2id hash for email/password sign-in -- the column is
nullable because OAuth accounts have none. The OAuth token columns are the
mirror case: null for password accounts.`,
    /*
     * Better Auth 1.7 scopes account identity by `issuer`, and the runtime
     * adapter refuses to write an account without the column ("The field
     * \"issuer\" does not exist in the \"account\" Drizzle schema") -- which
     * breaks sign-up entirely. Its own CLI does not emit the column, so the
     * drift test cannot catch the gap: generator and runtime disagree. Added
     * here until the generator catches up.
     */
    extraColumns: ['issuer: text("issuer"),'],
    extraIndexes: [
      `/*
     * The OAuth sign-in lookup: Better Auth resolves an account by
     * (providerId, accountId) on every callback. Leading with providerId makes
     * the index usable for "all accounts of this provider" too, which the
     * reverse order would not.
     */
    index("account_provider_account_idx").on(table.providerId, table.accountId)`,
    ],
    file: "accounts.ts",
  },
  session: {
    doc: `Active sessions. \`token\` is what the client presents; it is unique and
indexed by that constraint, and \`user_id\` carries its own index because every
session lookup filters on it.

\`onDelete: "cascade"\` is load-bearing: deleting a user must not strand sessions
that would otherwise still authenticate.`,
    extraColumns: [],
    extraIndexes: [],
    file: "sessions.ts",
  },
  user: {
    doc: `The account owner. The export is named \`user\`, singular, because that is the
model name Better Auth's Drizzle adapter looks up -- renaming it to \`users\`
would require an explicit mapping in \`drizzleAdapter\`.`,
    extraColumns: [],
    extraIndexes: [],
    file: "users.ts",
  },
  verification: {
    doc: `Short-lived tokens for email verification, password reset and magic links.

Nothing references this table, so it has no foreign key -- expired rows are safe
to prune on a schedule.`,
    extraColumns: [],
    extraIndexes: [
      `/*
     * Consuming a token matches identifier AND value together. The single
     * identifier index above still serves the cleanup query that prunes every
     * token for an address.
     */
    index("verification_identifier_value_idx").on(table.identifier, table.value)`,
    ],
    file: "verifications.ts",
  },
} as const;

type TableName = keyof typeof TABLES;

/** Extracts `export const <name> = <callee>(...);` by matching parentheses. */
function extractBlock(source: string, name: string): string {
  const start = source.indexOf(`export const ${name} = `);
  if (start === -1) {
    throw new Error(`Generated file has no export named "${name}"`);
  }

  let depth = 0;
  let seenOpen = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === "(") {
      depth += 1;
      seenOpen = true;
    } else if (char === ")") {
      depth -= 1;
      if (seenOpen && depth === 0) {
        // Include the trailing semicolon.
        return source.slice(start, source.indexOf(";", i) + 1);
      }
    }
  }

  throw new Error(`Unbalanced parentheses while extracting "${name}"`);
}

/** Every `timestamp("x")` becomes timezone-aware. */
function withTimezone(block: string): string {
  return block.replace(
    TIMESTAMP_PATTERN,
    'timestamp("$1", { withTimezone: true })'
  );
}

/** UUIDv7 default on the primary key, for inserts made outside Better Auth. */
function withGeneratedId(block: string): string {
  return block.replace(
    PRIMARY_KEY_PATTERN,
    'text("id").primaryKey().$defaultFn(newId)'
  );
}

/** Inserts extra columns at the head of the table's column object. */
function withExtraColumns(block: string, columns: readonly string[]): string {
  if (columns.length === 0) {
    return block;
  }

  // The first `{` after the table-name string opens the column object.
  const brace = block.indexOf("{", block.indexOf('"'));
  if (brace === -1) {
    throw new Error("Expected a column object to insert into");
  }

  const addition = columns.map((column) => `\n    ${column}`).join("");
  return block.slice(0, brace + 1) + addition + block.slice(brace + 1);
}

/** Appends composite indexes to the table's index array, or creates one. */
function withExtraIndexes(block: string, indexes: readonly string[]): string {
  if (indexes.length === 0) {
    return block;
  }

  const addition = indexes.map((index) => `    ${index},`).join("\n");
  const closing = block.lastIndexOf("]");
  if (closing === -1) {
    throw new Error("Expected an index array to append to");
  }

  const head = block
    .slice(0, closing)
    .trimEnd()
    .replace(TRAILING_COMMA_PATTERN, "");
  return `${head},\n${addition}\n  ${block.slice(closing)}`;
}

function importsFor(block: string, needsNewId: boolean): string {
  const pgCore = ["boolean", "index", "pgTable", "text", "timestamp"].filter(
    (symbol) => new RegExp(`\\b${symbol}\\(`).test(block)
  );

  const lines = [`import { ${pgCore.join(", ")} } from "drizzle-orm/pg-core";`];
  if (needsNewId) {
    lines.push('import { newId } from "../id";');
  }
  if (USER_REFERENCE_PATTERN.test(block)) {
    lines.push('import { user } from "./users";');
  }
  return lines.sort().join("\n");
}

function docBlock(text: string): string {
  const body = text
    .split("\n")
    .map((line) => (line ? ` * ${line}` : " *"))
    .join("\n");
  return `/**\n${body}\n */`;
}

async function main(): Promise<void> {
  await mkdir(dirname(REFERENCE), { recursive: true });

  /*
   * Step 1: the CLI writes its verbatim output to the reference file, which is
   * versioned so that a Better Auth upgrade produces a reviewable diff.
   *
   * The unlink is load-bearing. Pointed at an existing file the CLI reports
   * "Schema was overwritten successfully!" but leaves new columns out -- adding
   * the username plugin produced no diff at all until the file was removed
   * first. Regenerating into a fresh path is the only way to be sure the output
   * reflects the current config.
   */
  await rm(REFERENCE, { force: true });
  await $`bunx @better-auth/cli generate --config ./src/server.ts --output ${REFERENCE} --yes`.cwd(
    AUTH_ROOT
  );

  const generated = await readFile(REFERENCE, "utf8");
  const written: string[] = [];
  const pending: Promise<void>[] = [];

  // Step 2: one file per table, transforms applied.
  for (const [name, config] of Object.entries(TABLES) as [
    TableName,
    (typeof TABLES)[TableName],
  ][]) {
    let block = extractBlock(generated, name);
    block = withTimezone(block);
    block = withGeneratedId(block);
    block = withExtraColumns(block, config.extraColumns);
    block = withExtraIndexes(block, config.extraIndexes);

    const banner =
      "// Generated by packages/auth/scripts/generate-schema.ts -- do not edit.\n// Run `bun run auth:generate` in @repo/auth after changing the auth config.";
    const file = [
      banner,
      "",
      importsFor(block, block.includes("$defaultFn(newId)")),
      "",
      docBlock(config.doc),
      block,
      "",
    ].join("\n");

    pending.push(writeFile(join(DB_SCHEMA, config.file), file));
    written.push(config.file);
  }

  await Promise.all(pending);

  // Step 3: relations in their own leaf module. Declaring them beside the
  // tables would make users.ts and sessions.ts import each other.
  const relationBlocks = [
    "userRelations",
    "sessionRelations",
    "accountRelations",
  ]
    .map((name) => extractBlock(generated, name))
    .join("\n\n");

  const relations = [
    "// Generated by packages/auth/scripts/generate-schema.ts -- do not edit.",
    "",
    'import { relations } from "drizzle-orm";',
    'import { account } from "./accounts";',
    'import { session } from "./sessions";',
    'import { user } from "./users";',
    "",
    docBlock(`Relations live apart from the tables on purpose.

\`userRelations\` needs \`session\` and \`account\`, and both of those need \`user\`.
Declaring them beside the tables makes users.ts and sessions.ts import each
other; Drizzle's lazy callbacks survive that cycle, but it is a cycle a future
edit can easily break.`),
    relationBlocks,
    "",
  ].join("\n");

  await writeFile(join(DB_SCHEMA, "relations.ts"), relations);
  written.push("relations.ts");

  /*
   * Format as the final step. Without it `bun run lint:fix` would reformat
   * these files afterwards, and the next generation would emit the unformatted
   * version again -- an endless diff between the two commands. Formatting here
   * makes the output a fixed point of both.
   */
  await $`bunx biome check --write ${DB_SCHEMA}`.quiet().nothrow();

  process.stdout.write(`schema written: ${written.join(", ")}\n`);
}

await main();
