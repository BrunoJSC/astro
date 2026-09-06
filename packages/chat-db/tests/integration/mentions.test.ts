import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "cassandra-driver";
import {
  getMessageMentions,
  getUserMentions,
  recordMentions,
} from "../../src/mentions";
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
 * Mentions, against a real server.
 *
 * The fan-out writes to as many partitions as there are mentioned users, and
 * the inbox reads back through the same bounded bucket walk as message history.
 * Neither is observable from a fake.
 */

const available = await reachable();
if (!available) {
  announceSkip("chat-db/mentions");
}

describe.skipIf(!available)("recording mentions", () => {
  let db: Client;

  beforeAll(async () => {
    const ddl = rawClient();
    await ddl.connect();
    await applySchema(ddl);
    await ddl.shutdown();

    db = keyspaceClient();
    await db.connect();
  });

  afterAll(async () => {
    await db?.shutdown();
  });

  it("puts one row in each mentioned user's inbox", async () => {
    const author = newUuid().toString();
    const alice = newUuid().toString();
    const bob = newUuid().toString();
    const channelId = newUuid().toString();

    await recordMentions(db, {
      authorId: author,
      channelId,
      content: "hi @alice @bob",
      mentionedUsers: [alice, bob],
      messageId: timeuuidAt("2026-09-10T12:00:00Z"),
    });

    for (const userId of [alice, bob]) {
      const page = await getUserMentions(db, { userId });
      expect(page.mentions).toHaveLength(1);
      expect(page.mentions[0]).toMatchObject({
        authorId: author,
        channelId,
        contentPreview: "hi @alice @bob",
      });
    }
  });

  it("does not badge the author for mentioning themselves", async () => {
    const author = newUuid().toString();

    await recordMentions(db, {
      authorId: author,
      channelId: newUuid().toString(),
      content: "talking to myself",
      mentionedUsers: [author],
      messageId: timeuuidAt("2026-09-10T12:00:00Z"),
    });

    expect((await getUserMentions(db, { userId: author })).mentions).toEqual(
      []
    );
  });

  it("does NOT expand a role mention into inboxes", async () => {
    /*
     * Expanding @role for a 50,000-member role would write 50,000 inbox rows
     * for one message, and a membership change afterwards would leave them
     * wrong with no tractable way to rewrite history.
     */
    const messageId = timeuuidAt("2026-09-10T12:00:00Z");
    const roleId = newUuid().toString();

    await recordMentions(db, {
      authorId: newUuid().toString(),
      channelId: newUuid().toString(),
      content: "@everyone ship it",
      mentionedRoles: [roleId],
      mentionsEveryone: true,
      messageId,
    });

    const mentions = await getMessageMentions(db, messageId);

    expect(mentions?.mentionedRoles).toEqual([roleId]);
    expect(mentions?.mentionsEveryone).toBe(true);
    expect(mentions?.mentionedUsers).toEqual([]);
  });

  it("stores a preview, so the inbox never reads message history", async () => {
    const userId = newUuid().toString();

    await recordMentions(db, {
      authorId: newUuid().toString(),
      channelId: newUuid().toString(),
      content: `  spaced   out  ${"x".repeat(400)}`,
      mentionedUsers: [userId],
      messageId: timeuuidAt("2026-09-10T12:00:00Z"),
    });

    const [mention] = (await getUserMentions(db, { userId })).mentions;

    expect(mention?.contentPreview).toHaveLength(140);
    expect(mention?.contentPreview.startsWith("spaced out ")).toBe(true);
  });

  it("distinguishes a DM, where guildId is null", async () => {
    const userId = newUuid().toString();

    await recordMentions(db, {
      authorId: newUuid().toString(),
      channelId: newUuid().toString(),
      content: "dm",
      guildId: null,
      mentionedUsers: [userId],
      messageId: timeuuidAt("2026-09-10T12:00:00Z"),
    });

    const [mention] = (await getUserMentions(db, { userId })).mentions;
    expect(mention?.guildId).toBeNull();
  });

  it("returns null for a message that mentioned nothing", async () => {
    expect(
      await getMessageMentions(db, timeuuidAt("2026-01-01T00:00:00Z"))
    ).toBeNull();
  });
});

describe.skipIf(!available)("the mention inbox", () => {
  let db: Client;
  const userId = newUuid().toString();

  beforeAll(async () => {
    const ddl = rawClient();
    await ddl.connect();
    await applySchema(ddl);
    await ddl.shutdown();

    db = keyspaceClient();
    await db.connect();

    // Two mentions a month across four months, so a page has to cross a
    // partition boundary.
    for (const month of ["06", "07", "08", "09"]) {
      for (const day of ["10", "20"]) {
        await recordMentions(db, {
          authorId: newUuid().toString(),
          channelId: newUuid().toString(),
          content: `2026-${month}-${day}`,
          mentionedUsers: [userId],
          messageId: timeuuidAt(`2026-${month}-${day}T12:00:00Z`),
        });
      }
    }
  });

  afterAll(async () => {
    await db?.shutdown();
  });

  it("returns newest first, across buckets", async () => {
    const page = await getUserMentions(db, {
      before: timeuuidAt("2026-09-30T00:00:00Z"),
      limit: 4,
      userId,
    });

    expect(page.mentions.map((m) => m.contentPreview)).toEqual([
      "2026-09-20",
      "2026-09-10",
      "2026-08-20",
      "2026-08-10",
    ]);
  });

  it("resumes from the cursor without repeating", async () => {
    const first = await getUserMentions(db, {
      before: timeuuidAt("2026-09-30T00:00:00Z"),
      limit: 3,
      userId,
    });
    const second = await getUserMentions(db, {
      before: first.cursor ?? undefined,
      limit: 3,
      userId,
    });

    const seen = [...first.mentions, ...second.mentions].map(
      (m) => m.contentPreview
    );
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("reports when it stopped at the bucket bound", async () => {
    const page = await getUserMentions(db, {
      before: timeuuidAt("2026-09-30T00:00:00Z"),
      limit: 100,
      maxBucketsScanned: 2,
      userId,
    });

    expect(page.mentions).toHaveLength(4);
    expect(page.boundReached).toBe(true);
  });

  it("buckets a late write by the id's month", async () => {
    // Same rule as message history: from the id, never the clock.
    const late = newUuid().toString();

    await recordMentions(db, {
      authorId: newUuid().toString(),
      channelId: newUuid().toString(),
      content: "backfilled",
      mentionedUsers: [late],
      messageId: timeuuidAt("2026-03-14T10:00:00Z"),
    });

    const result = await db.execute(
      `SELECT content_preview FROM mentions_by_user
        WHERE user_id = ? AND bucket_year_month = ?`,
      [late, "2026-03"],
      { prepare: true }
    );

    expect(result.first()?.content_preview).toBe("backfilled");
  });

  it("keeps users apart", async () => {
    const page = await getUserMentions(db, { userId: newUuid().toString() });
    expect(page.mentions).toEqual([]);
  });
});
