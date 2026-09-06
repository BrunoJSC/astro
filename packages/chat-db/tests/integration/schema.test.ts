import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "cassandra-driver";
import {
  announceSkip,
  applySchema,
  KEYSPACE,
  keyspaceClient,
  newTimeuuid,
  newUuid,
  rawClient,
  reachable,
} from "./helpers";

/**
 * The schema, applied to a server rather than read as text.
 *
 * `tests/unit/schema.test.ts` parses the CQL and checks it against the
 * wrappers, which catches a deleted table or a renamed column. It cannot catch
 * CQL that parses but is rejected, and that has already happened here once: the
 * Postgres `message_reactions` table this replaces was structurally impossible
 * and nobody noticed until an insert was attempted.
 */

const NULL_VALUE = /null value/i;

const available = await reachable();
if (!available) {
  announceSkip("chat-db/schema");
}

describe.skipIf(!available)("applying cql/", () => {
  let ddl: Client;

  beforeAll(async () => {
    ddl = rawClient();
    await ddl.connect();
  });

  afterAll(async () => {
    await ddl?.shutdown();
  });

  it("applies every file cleanly", async () => {
    const applied = await applySchema(ddl);

    expect(applied).toEqual([
      "001_keyspace.cql",
      "002_messages.cql",
      "003_logs.cql",
      "004_reactions_mentions.cql",
    ]);
  });

  it("is idempotent, so a redeploy is not a migration", async () => {
    // Every statement is IF NOT EXISTS. Running the directory twice has to be
    // a no-op, or applying it in an environment that already has it is a
    // failure rather than a confirmation.
    await applySchema(ddl);
    await applySchema(ddl);
  });

  it("creates exactly the seven tables the wrappers expect", async () => {
    const result = await ddl.execute(
      "SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?",
      [KEYSPACE],
      { prepare: true }
    );

    expect(result.rows.map((row) => row.table_name as string).sort()).toEqual([
      "audit_logs_by_guild",
      "direct_messages",
      "mentions_by_message",
      "mentions_by_user",
      "messages_by_channel",
      "moderation_logs_by_guild",
      "reactions_by_message",
    ]);
  });
});

describe.skipIf(!available)("key structure", () => {
  let ddl: Client;

  beforeAll(async () => {
    ddl = rawClient();
    await ddl.connect();
    await applySchema(ddl);
  });

  afterAll(async () => {
    await ddl?.shutdown();
  });

  /**
   * `kind` is one of partition_key / clustering / regular / static.
   *
   * Typed as plain records: these are rows from `system_schema`, whose columns
   * the driver has no declarations for, so anything narrower would be invented.
   */
  async function columns(table: string): Promise<Record<string, unknown>[]> {
    const result = await ddl.execute(
      `SELECT column_name, kind, position, clustering_order
         FROM system_schema.columns
        WHERE keyspace_name = ? AND table_name = ?`,
      [KEYSPACE, table],
      { prepare: true }
    );
    return result.rows as unknown as Record<string, unknown>[];
  }

  const of = (rows: Record<string, unknown>[], kind: string) =>
    rows.filter((row) => row.kind === kind);

  it("bucket every time-growing table, and only those", async () => {
    // A partition is the unit of storage, replication and repair. An unbounded
    // one eventually cannot be repaired at all.
    for (const table of [
      "messages_by_channel",
      "direct_messages",
      "mentions_by_user",
      "audit_logs_by_guild",
    ]) {
      const partition = of(await columns(table), "partition_key").map(
        (row) => row.column_name as string
      );
      expect(partition, `${table} must be bucketed`).toContain(
        "bucket_year_month"
      );
    }
  });

  it("leaves reactions unbucketed, because they are bounded by audience", async () => {
    const rows = await columns("reactions_by_message");
    const partition = of(rows, "partition_key").map(
      (row) => row.column_name as string
    );

    expect(partition).toEqual(["message_id"]);
    expect(rows.map((row) => row.column_name)).not.toContain(
      "bucket_year_month"
    );
  });

  it("identifies a reaction's emoji with ONE clustering column", async () => {
    /*
     * The shape the whole table rests on. Two nullable emoji columns in the key
     * would reject every insert -- see the null test below -- so `emoji_key`
     * carries both cases and `custom_emoji_id` is a regular column, where null
     * is legal.
     */
    const rows = await columns("reactions_by_message");
    const clustering = of(rows, "clustering")
      .sort((a, b) => Number(a.position) - Number(b.position))
      .map((row) => row.column_name as string);

    expect(clustering).toEqual(["emoji_key", "user_id"]);
    expect(
      of(rows, "regular").map((row) => row.column_name as string)
    ).toContain("custom_emoji_id");
  });

  it("orders message history newest-first in the schema, not in a query", async () => {
    // `ORDER BY` on a read can only reverse the declared order; the reads in
    // `src/` rely on the default being DESC.
    for (const table of ["messages_by_channel", "direct_messages"]) {
      const [clustering] = of(await columns(table), "clustering");
      expect(clustering?.clustering_order, table).toBe("desc");
    }
  });
});

describe.skipIf(!available)("compaction", () => {
  let ddl: Client;

  beforeAll(async () => {
    ddl = rawClient();
    await ddl.connect();
    await applySchema(ddl);
  });

  afterAll(async () => {
    await ddl?.shutdown();
  });

  async function compactionOf(table: string): Promise<Record<string, string>> {
    const result = await ddl.execute(
      `SELECT compaction FROM system_schema.tables
        WHERE keyspace_name = ? AND table_name = ?`,
      [KEYSPACE, table],
      { prepare: true }
    );
    return result.first()?.compaction as Record<string, string>;
  }

  it("uses TimeWindow for the append-only tables", async () => {
    for (const table of [
      "messages_by_channel",
      "direct_messages",
      "mentions_by_user",
      "audit_logs_by_guild",
      "moderation_logs_by_guild",
    ]) {
      const compaction = await compactionOf(table);
      expect(compaction.class, table).toContain("TimeWindowCompactionStrategy");
    }
  });

  it("uses Leveled for reactions, the one table that is not append-only", async () => {
    /*
     * Removing a reaction is a delete and toggling one is a delete followed by
     * an insert. TWCS assumes rows are written once and never touched, and
     * would strand tombstones in windows it never recompacts.
     */
    const compaction = await compactionOf("reactions_by_message");
    expect(compaction.class).toContain("LeveledCompactionStrategy");
  });
});

describe.skipIf(!available)("what CQL rejects", () => {
  let kv: Client;

  beforeAll(async () => {
    const ddl = rawClient();
    await ddl.connect();
    await applySchema(ddl);
    await ddl.shutdown();

    kv = keyspaceClient();
    await kv.connect();
  });

  afterAll(async () => {
    await kv?.shutdown();
  });

  it("REFUSES null in a clustering column", async () => {
    /*
     * The assertion the reactions table exists for.
     *
     * The obvious model is two nullable columns -- `emoji` for Unicode,
     * `custom_emoji_id` for a guild emoji, exactly one set. It cannot work:
     * every insert would be refused, a Unicode reaction for its null id and a
     * custom one for its null character. Not some. All of them.
     *
     * This is the second time this project met that class of bug. The Postgres
     * table this replaces was unusable for the mirror-image reason -- a
     * composite primary key makes its columns implicitly NOT NULL, which
     * contradicted a CHECK requiring exactly one to be null.
     *
     * If this ever passes, the single-column design has stopped being
     * load-bearing and the long comment in cql/004 is stale.
     */
    await expect(
      kv.execute(
        "INSERT INTO reactions_by_message (message_id, emoji_key, user_id) VALUES (?, ?, ?)",
        [newTimeuuid(), null, newUuid()],
        { prepare: true }
      )
    ).rejects.toThrow(NULL_VALUE);
  });

  it("refuses null in a partition key too", async () => {
    await expect(
      kv.execute(
        "INSERT INTO reactions_by_message (message_id, emoji_key, user_id) VALUES (?, ?, ?)",
        [null, "🎉", newUuid()],
        { prepare: true }
      )
    ).rejects.toThrow(NULL_VALUE);
  });

  it("ALLOWS null in a regular column, which is why custom_emoji_id is one", async () => {
    const messageId = newTimeuuid();

    await kv.execute(
      `INSERT INTO reactions_by_message
         (message_id, emoji_key, user_id, custom_emoji_id, created_at)
       VALUES (?, ?, ?, ?, toTimestamp(now()))`,
      [messageId, "🎉", newUuid(), null],
      { prepare: true }
    );

    const result = await kv.execute(
      "SELECT custom_emoji_id FROM reactions_by_message WHERE message_id = ?",
      [messageId],
      { prepare: true }
    );

    expect(result.first()?.custom_emoji_id).toBeNull();
  });

  it("refuses a partial partition key without ALLOW FILTERING", async () => {
    // Why the bucket walk in `src/messages.ts` exists: a bucketed table cannot
    // be read by channel alone, and the alternative is a cluster-wide scan.
    await expect(
      kv.execute(
        "SELECT message_id FROM messages_by_channel WHERE channel_id = ?",
        [newUuid()],
        { prepare: true }
      )
    ).rejects.toThrow();
  });
});
