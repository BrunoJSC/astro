import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "@neondatabase/serverless";
import {
  announceSkip,
  applyMigrations,
  connectDb,
  reachable,
  resetSchema,
  type TestDatabase,
} from "./helpers";

/**
 * The constraints, enforced rather than declared.
 *
 * A foreign key in a Drizzle definition is a hope until the database has one.
 * These are the invariants the application relies on and never checks itself:
 * cascades, uniqueness, and the composite keys that stand in for "this can
 * only happen once".
 */

const FOREIGN_KEY = /foreign key/i;
const DUPLICATE = /duplicate key|unique/i;

const available = await reachable();
if (!available) {
  announceSkip("db/constraints");
}

describe.skipIf(!available)("referential integrity", () => {
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

  async function newUser(): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO "user" (name, email, email_verified)
       VALUES ('u', $1, false) RETURNING id`,
      [`${crypto.randomUUID()}@example.test`]
    );
    return result.rows[0]?.id ?? "";
  }

  async function newGuild(): Promise<{ guildId: string; ownerId: string }> {
    const ownerId = await newUser();
    const result = await pool.query<{ id: string }>(
      "INSERT INTO guilds (name, owner_id) VALUES ('g', $1) RETURNING id",
      [ownerId]
    );
    return { guildId: result.rows[0]?.id ?? "", ownerId };
  }

  it("refuses a channel in a guild that does not exist", async () => {
    await expect(
      pool.query(
        "INSERT INTO channels (guild_id, name, type) VALUES ($1, 'c', 'text')",
        [crypto.randomUUID()]
      )
    ).rejects.toThrow(FOREIGN_KEY);
  });

  it("cascades a deleted guild to its channels", async () => {
    const { guildId } = await newGuild();
    await pool.query(
      "INSERT INTO channels (guild_id, name, type) VALUES ($1, 'c', 'text')",
      [guildId]
    );

    await pool.query("DELETE FROM guilds WHERE id = $1", [guildId]);

    const left = await pool.query(
      "SELECT 1 FROM channels WHERE guild_id = $1",
      [guildId]
    );
    expect(left.rows).toEqual([]);
  });

  it("cascades a deleted user to their sessions", async () => {
    const userId = await newUser();
    await pool.query(
      `INSERT INTO session (expires_at, token, user_id, updated_at)
       VALUES (now() + interval '1 day', $1, $2, now())`,
      [crypto.randomUUID(), userId]
    );

    await pool.query('DELETE FROM "user" WHERE id = $1', [userId]);

    const left = await pool.query("SELECT 1 FROM session WHERE user_id = $1", [
      userId,
    ]);
    expect(left.rows).toEqual([]);
  });

  it("lifts a category's children instead of deleting them", async () => {
    /*
     * The self-referencing key, with ON DELETE SET NULL rather than CASCADE.
     * Deleting a category must not take the channels inside it -- the app
     * lifts them to the root, and that is only possible if the row survives.
     */
    const { guildId } = await newGuild();
    const category = await pool.query<{ id: string }>(
      "INSERT INTO channels (guild_id, name, type) VALUES ($1, 'cat', 'category') RETURNING id",
      [guildId]
    );
    const categoryId = category.rows[0]?.id ?? "";

    const child = await pool.query<{ id: string }>(
      `INSERT INTO channels (guild_id, name, type, category_id)
       VALUES ($1, 'c', 'text', $2) RETURNING id`,
      [guildId, categoryId]
    );
    const childId = child.rows[0]?.id ?? "";

    await pool.query("DELETE FROM channels WHERE id = $1", [categoryId]);

    const survivor = await pool.query<{ category_id: string | null }>(
      "SELECT category_id FROM channels WHERE id = $1",
      [childId]
    );
    expect(survivor.rows).toHaveLength(1);
    expect(survivor.rows[0]?.category_id).toBeNull();
  });
});

describe.skipIf(!available)("uniqueness", () => {
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

  it("refuses a second user with the same email", async () => {
    const email = `${crypto.randomUUID()}@example.test`;
    const insert = () =>
      pool.query(
        `INSERT INTO "user" (name, email, email_verified) VALUES ('u', $1, false)`,
        [email]
      );

    await insert();
    await expect(insert()).rejects.toThrow(DUPLICATE);
  });

  it("lets a user join a guild once, and only once", async () => {
    // The composite primary key IS the identity here -- there is no surrogate
    // id to make a second row look legitimate.
    const owner = await pool.query<{ id: string }>(
      `INSERT INTO "user" (name, email, email_verified)
       VALUES ('u', $1, false) RETURNING id`,
      [`${crypto.randomUUID()}@example.test`]
    );
    const ownerId = owner.rows[0]?.id ?? "";
    const guild = await pool.query<{ id: string }>(
      "INSERT INTO guilds (name, owner_id) VALUES ('g', $1) RETURNING id",
      [ownerId]
    );
    const guildId = guild.rows[0]?.id ?? "";

    const join = () =>
      pool.query(
        "INSERT INTO guild_members (guild_id, user_id) VALUES ($1, $2)",
        [guildId, ownerId]
      );

    await join();
    await expect(join()).rejects.toThrow(DUPLICATE);
  });
});

describe.skipIf(!available)("the seam to ScyllaDB", () => {
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

  it("stores a Scylla timeuuid with no foreign key to enforce", async () => {
    /*
     * `channel_read_state.last_read_message_id` points at a row in ScyllaDB,
     * so there is nothing for Postgres to reference. It is deliberately opaque
     * here: UUIDv1 lays its timestamp out low-bits-first, so a bytewise
     * comparison in Postgres is NOT chronological and the unread calculation
     * has to happen in Scylla.
     */
    const user = await pool.query<{ id: string }>(
      `INSERT INTO "user" (name, email, email_verified)
       VALUES ('u', $1, false) RETURNING id`,
      [`${crypto.randomUUID()}@example.test`]
    );
    const userId = user.rows[0]?.id ?? "";
    const guild = await pool.query<{ id: string }>(
      "INSERT INTO guilds (name, owner_id) VALUES ('g', $1) RETURNING id",
      [userId]
    );
    const channel = await pool.query<{ id: string }>(
      "INSERT INTO channels (guild_id, name, type) VALUES ($1, 'c', 'text') RETURNING id",
      [guild.rows[0]?.id ?? ""]
    );

    // A real UUIDv1, as `types.TimeUuid` produces.
    const timeuuid = "ba979001-2055-11f1-abfb-5d12c6690d69";

    await pool.query(
      `INSERT INTO channel_read_state (user_id, channel_id, last_read_message_id)
       VALUES ($1, $2, $3)`,
      [userId, channel.rows[0]?.id ?? "", timeuuid]
    );

    const stored = await pool.query<{ last_read_message_id: string }>(
      "SELECT last_read_message_id FROM channel_read_state WHERE user_id = $1",
      [userId]
    );
    expect(stored.rows[0]?.last_read_message_id).toBe(timeuuid);
  });

  it("has no foreign key on that column", async () => {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*) AS count
         FROM information_schema.key_column_usage k
         JOIN information_schema.table_constraints c
           ON c.constraint_name = k.constraint_name
        WHERE k.table_name = 'channel_read_state'
          AND k.column_name = 'last_read_message_id'
          AND c.constraint_type = 'FOREIGN KEY'`
    );

    expect(Number(result.rows[0]?.count)).toBe(0);
  });
});
