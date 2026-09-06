import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "cassandra-driver";
import {
  getAuditLogs,
  getModerationLogs,
  writeAuditLog,
  writeModerationLog,
} from "../../src/logs";
import {
  announceSkip,
  applySchema,
  keyspaceClient,
  newUuid,
  rawClient,
  reachable,
  timeuuidAt,
} from "./helpers";

/**
 * Audit and moderation logs, against a real server.
 *
 * The two tables are shaped differently on purpose -- one bucketed, one not --
 * and the difference is only visible in how they are read.
 */

const available = await reachable();
if (!available) {
  announceSkip("chat-db/logs");
}

describe.skipIf(!available)("audit logs", () => {
  let db: Client;
  const guildId = newUuid().toString();

  beforeAll(async () => {
    const ddl = rawClient();
    await ddl.connect();
    await applySchema(ddl);
    await ddl.shutdown();

    db = keyspaceClient();
    await db.connect();

    /*
     * Deliberately in the PAST. `getAuditLogs` and `getModerationLogs` default
     * their cursor to `TimeUuid.max(new Date())`, so a row dated later today --
     * or later this month -- is correctly excluded and a test seeded that way
     * fails for a reason that has nothing to do with what it claims to check.
     */
    for (const month of ["04", "05", "06"]) {
      for (const day of ["10", "20"]) {
        await writeAuditLog(db, {
          actionType: `action-${month}-${day}`,
          actorId: newUuid().toString(),
          changes: { after: 1, before: 0 },
          guildId,
          logId: timeuuidAt(`2026-${month}-${day}T12:00:00Z`),
          targetId: newUuid().toString(),
        });
      }
    }
  });

  afterAll(async () => {
    await db?.shutdown();
  });

  it("returns newest first", async () => {
    const page = await getAuditLogs(db, { guildId, limit: 3 });

    expect(page.rows.map((row) => row.action_type)).toEqual([
      "action-06-20",
      "action-06-10",
      "action-05-20",
    ]);
  });

  it("walks backwards across buckets to fill a page", async () => {
    // Two entries a month, so a page of 5 spans three partitions.
    const page = await getAuditLogs(db, {
      before: timeuuidAt("2026-06-30T00:00:00Z"),
      guildId,
      limit: 5,
    });

    expect(page.rows).toHaveLength(5);
  });

  it("resumes from the cursor", async () => {
    const first = await getAuditLogs(db, {
      before: timeuuidAt("2026-06-30T00:00:00Z"),
      guildId,
      limit: 2,
    });
    const second = await getAuditLogs(db, {
      before: first.cursor ?? undefined,
      guildId,
      limit: 2,
    });

    const seen = [...first.rows, ...second.rows].map((row) => row.action_type);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([
      "action-06-20",
      "action-06-10",
      "action-05-20",
      "action-05-10",
    ]);
  });

  it("keeps guilds apart", async () => {
    const page = await getAuditLogs(db, { guildId: newUuid().toString() });
    expect(page.rows).toEqual([]);
  });

  it("buckets by the id's own month", async () => {
    const other = newUuid().toString();
    await writeAuditLog(db, {
      actionType: "backfilled",
      actorId: newUuid().toString(),
      changes: null,
      guildId: other,
      logId: timeuuidAt("2026-02-14T10:00:00Z"),
      targetId: newUuid().toString(),
    });

    const result = await db.execute(
      `SELECT action_type FROM audit_logs_by_guild
        WHERE guild_id = ? AND bucket_year_month = ?`,
      [other, "2026-02"],
      { prepare: true }
    );

    expect(result.first()?.action_type).toBe("backfilled");
  });
});

describe.skipIf(!available)("moderation logs", () => {
  let db: Client;
  const guildId = newUuid().toString();

  beforeAll(async () => {
    const ddl = rawClient();
    await ddl.connect();
    await applySchema(ddl);
    await ddl.shutdown();

    db = keyspaceClient();
    await db.connect();

    // Past months, for the same reason as the audit seed above.
    for (const month of ["01", "03", "05"]) {
      await writeModerationLog(db, {
        action: `mod-${month}`,
        durationSeconds: null,
        guildId,
        logId: timeuuidAt(`2026-${month}-15T12:00:00Z`),
        moderatorId: newUuid().toString(),
        reason: "spam",
        targetUserId: newUuid().toString(),
      });
    }
  });

  afterAll(async () => {
    await db?.shutdown();
  });

  it("reads a whole year in one partition, with no bucket walk", async () => {
    /*
     * The deliberate exception. This table is unbounded by specification --
     * a moderation history is meant to be readable end to end -- so it is one
     * partition per guild and the read never walks. The arithmetic that makes
     * that acceptable (~146 MB/year) is in cql/003_logs.cql.
     */
    const page = await getModerationLogs(db, { guildId, limit: 10 });

    expect(page.rows.map((row) => row.action)).toEqual([
      "mod-05",
      "mod-03",
      "mod-01",
    ]);
  });

  it("round-trips the reason", async () => {
    const [row] = (await getModerationLogs(db, { guildId, limit: 1 })).rows;
    expect(row?.reason).toBe("spam");
  });

  it("pages with a cursor", async () => {
    const first = await getModerationLogs(db, { guildId, limit: 1 });
    const second = await getModerationLogs(db, {
      before: first.cursor ?? undefined,
      guildId,
      limit: 1,
    });

    expect(first.rows[0]?.action).toBe("mod-05");
    expect(second.rows[0]?.action).toBe("mod-03");
  });

  it("keeps guilds apart", async () => {
    const page = await getModerationLogs(db, {
      guildId: newUuid().toString(),
    });
    expect(page.rows).toEqual([]);
  });
});
