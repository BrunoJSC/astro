import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "@neondatabase/serverless";
import {
  announceSkip,
  applyMigrations,
  connectDb,
  MIN_SERVER_VERSION,
  reachable,
  resetSchema,
  serverMajorVersion,
  stopProxy,
  type TestDatabase,
} from "./helpers";

/**
 * The migration, applied to a real Postgres.
 *
 * `tests/unit/schema.test.ts` reads the Drizzle definitions and
 * `drift.test.ts` compares them to what the Better Auth codemod emits. Neither
 * runs a single statement, so nothing has ever confirmed the SQL is valid, that
 * it produces the tables the schema declares, or that the defaults fire.
 */

/** Version 7, variant 1 -- the shape `uuidv7()` must produce. */
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const available = await reachable();
if (!available) {
  announceSkip("db/migration");
}

describe.skipIf(!available)("applying drizzle/", () => {
  let context: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    context = await connectDb();
    ({ pool } = context);
    await resetSchema(pool);
  });

  afterAll(async () => {
    await context?.close();
    stopProxy();
  });

  it("runs on a server new enough for the schema", async () => {
    /*
     * Checked first, and explicitly. Every primary key defaults to `uuidv7()`,
     * an 18 builtin, so on 17 the migration fails at the first table with an
     * "unknown function" error that reads like a typo rather than a version
     * problem.
     */
    expect(await serverMajorVersion(pool)).toBeGreaterThanOrEqual(
      MIN_SERVER_VERSION
    );
  });

  it("applies every statement", async () => {
    const statements = await applyMigrations(pool);
    expect(statements.length).toBeGreaterThan(50);
  });

  it("creates the fourteen tables the schema declares", async () => {
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`
    );

    expect(result.rows.map((row) => row.table_name)).toEqual([
      "account",
      "channel_permission_overrides",
      "channel_read_state",
      "channels",
      "friends",
      "guild_emojis",
      "guild_members",
      "guilds",
      "invites",
      "member_roles",
      "roles",
      "session",
      "user",
      "verification",
    ]);
  });

  it("creates the three enums, with the values the TypeScript declares", async () => {
    /*
     * Aggregated here rather than with `array_agg`. The driver hands a
     * Postgres array back as its literal text -- `{text,voice,...}` -- and
     * comparing that to a JavaScript array passes nothing and explains less.
     */
    const result = await pool.query<{ enum_name: string; label: string }>(
      `SELECT t.typname AS enum_name, e.enumlabel AS label
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
        ORDER BY t.typname, e.enumsortorder`
    );

    const enums: Record<string, string[]> = {};
    for (const row of result.rows) {
      const labels = enums[row.enum_name] ?? [];
      labels.push(row.label);
      enums[row.enum_name] = labels;
    }

    expect(Object.keys(enums).sort()).toEqual([
      "channel_type",
      "friend_status",
      "permission_target_type",
    ]);
    // Declaration order is preserved, and it matters: `pending` first means a
    // new row's natural default is the state a request starts in.
    expect(enums.friend_status).toEqual(["pending", "accepted", "blocked"]);
    expect(enums.channel_type).toEqual([
      "text",
      "voice",
      "category",
      "dm",
      "group_dm",
    ]);
    expect(enums.permission_target_type).toEqual(["role", "member"]);
  });

  it("has no message tables, which moved to ScyllaDB", async () => {
    // The seam between the two datastores. A message table reappearing here
    // means someone re-added the Postgres model rather than using @repo/chat-db.
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('messages', 'attachments', 'reactions', 'mentions')`
    );

    expect(result.rows).toEqual([]);
  });
});

describe.skipIf(!available)("defaults", () => {
  let context: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    context = await connectDb();
    ({ pool } = context);
    await resetSchema(pool);
    await applyMigrations(pool);
  });

  afterAll(async () => {
    await context?.close();
  });

  /** `guilds.owner_id` is NOT NULL, so every guild needs a user first. */
  async function newUser(): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO "user" (name, email, email_verified)
       VALUES ('u', $1, false) RETURNING id`,
      [`${crypto.randomUUID()}@example.test`]
    );
    return result.rows[0]?.id ?? "";
  }

  it("generates an id server-side when the client supplies none", async () => {
    /*
     * The bug this defends against, and it was a real one. `$defaultFn` is a
     * Drizzle-side default: it runs in JavaScript, so a raw SQL insert -- a
     * migration, a backfill, psql -- bypasses it entirely and hits NOT NULL.
     * Every primary key therefore carries BOTH, and this proves the database
     * half.
     */
    const ownerId = await newUser();
    const result = await pool.query<{ id: string }>(
      "INSERT INTO guilds (name, owner_id) VALUES ('g', $1) RETURNING id",
      [ownerId]
    );

    const id = result.rows[0]?.id ?? "";
    expect(id).toMatch(UUID_V7);
  });

  it("generates ids that sort in creation order", async () => {
    // The reason for v7 over v4. A v4 primary key scatters inserts across the
    // index; v7 appends, and range scans by id become range scans by time.
    const ownerId = await newUser();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = await pool.query<{ id: string }>(
        "INSERT INTO guilds (name, owner_id) VALUES ('g', $1) RETURNING id",
        [ownerId]
      );
      ids.push(result.rows[0]?.id ?? "");
    }

    expect([...ids].sort()).toEqual(ids);
  });

  it("stamps created_at with a timezone", async () => {
    const result = await pool.query<{ typ: string }>(
      `SELECT data_type AS typ FROM information_schema.columns
        WHERE table_name = 'guilds' AND column_name = 'created_at'`
    );

    // `timestamp without time zone` is the Drizzle default and the wrong one:
    // it silently drops the offset and two servers in different zones disagree.
    expect(result.rows[0]?.typ).toBe("timestamp with time zone");
  });
});
