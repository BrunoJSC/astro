import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "cassandra-driver";
import {
  addReaction,
  getMessageReactions,
  removeReaction,
} from "../../src/reactions";
import {
  announceSkip,
  applySchema,
  keyspaceClient,
  newTimeuuid,
  newUuid,
  rawClient,
  reachable,
} from "./helpers";

/**
 * Reactions, against a real server.
 *
 * The table's whole shape -- one non-null `emoji_key` instead of two nullable
 * emoji columns -- exists because of a rule the server enforces and no fake can
 * show. `schema.test.ts` proves the rule; this proves the design that works
 * around it actually behaves.
 */

const COLLIDES = /collides/;

const available = await reachable();
if (!available) {
  announceSkip("chat-db/reactions");
}

describe.skipIf(!available)("reactions", () => {
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

  it("stores both kinds of emoji from one user on one message", async () => {
    /*
     * The case the two-nullable-column model could not represent at all: the
     * same user reacting with a Unicode emoji and a custom one on the same
     * message. Both need a row, and both rows need a non-null key.
     */
    const messageId = newTimeuuid();
    const userId = newUuid().toString();
    const customEmojiId = newUuid().toString();

    await addReaction(db, {
      emoji: { emoji: "🎉", kind: "unicode" },
      messageId,
      userId,
    });
    await addReaction(db, {
      emoji: { customEmojiId, kind: "custom" },
      messageId,
      userId,
    });

    const summaries = await getMessageReactions(db, { messageId });

    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.emoji)).toContainEqual({
      emoji: "🎉",
      kind: "unicode",
    });
    expect(summaries.map((s) => s.emoji)).toContainEqual({
      customEmojiId,
      kind: "custom",
    });
  });

  it("groups by emoji because the clustering order already did", async () => {
    // The wrapper's grouping is a single linear pass with no sorting, which is
    // only correct if the server returns rows adjacent by emoji_key.
    const messageId = newTimeuuid();
    const users = [newUuid().toString(), newUuid().toString()];

    for (const userId of users) {
      await addReaction(db, {
        emoji: { emoji: "🎉", kind: "unicode" },
        messageId,
        userId,
      });
    }
    await addReaction(db, {
      emoji: { emoji: "🔥", kind: "unicode" },
      messageId,
      userId: users[0] as string,
    });

    const summaries = await getMessageReactions(db, { messageId });

    expect(summaries.map((s) => s.count)).toEqual([2, 1]);
    expect(summaries.map((s) => (s.emoji as { emoji: string }).emoji)).toEqual([
      "🎉",
      "🔥",
    ]);
  });

  it("is idempotent, so reacting twice is not counted twice", async () => {
    const messageId = newTimeuuid();
    const userId = newUuid().toString();

    await addReaction(db, {
      emoji: { emoji: "🎉", kind: "unicode" },
      messageId,
      userId,
    });
    await addReaction(db, {
      emoji: { emoji: "🎉", kind: "unicode" },
      messageId,
      userId,
    });

    const [summary] = await getMessageReactions(db, { messageId });
    expect(summary?.count).toBe(1);
  });

  it("removes one reactor without touching the others", async () => {
    const messageId = newTimeuuid();
    const staying = newUuid().toString();
    const leaving = newUuid().toString();
    const emoji = { emoji: "🎉", kind: "unicode" } as const;

    await addReaction(db, { emoji, messageId, userId: staying });
    await addReaction(db, { emoji, messageId, userId: leaving });
    await removeReaction(db, { emoji, messageId, userId: leaving });

    const [summary] = await getMessageReactions(db, { messageId });

    expect(summary?.count).toBe(1);
    expect(summary?.userIds).toEqual([staying]);
  });

  it("flags the viewer's own reaction", async () => {
    const messageId = newTimeuuid();
    const viewer = newUuid().toString();
    const emoji = { emoji: "🎉", kind: "unicode" } as const;

    await addReaction(db, { emoji, messageId, userId: newUuid().toString() });
    await addReaction(db, { emoji, messageId, userId: viewer });

    const [mine] = await getMessageReactions(db, {
      messageId,
      viewerId: viewer,
    });
    const [theirs] = await getMessageReactions(db, {
      messageId,
      viewerId: newUuid().toString(),
    });

    expect(mine?.reactedByViewer).toBe(true);
    expect(theirs?.reactedByViewer).toBe(false);
  });

  it("caps retained user ids without distorting the count", async () => {
    // The UI shows a handful of names and a number; keeping 20,000 ids to
    // render "and 19,994 others" is waste.
    const messageId = newTimeuuid();
    const emoji = { emoji: "🎉", kind: "unicode" } as const;

    for (let i = 0; i < 12; i += 1) {
      await addReaction(db, { emoji, messageId, userId: newUuid().toString() });
    }

    const [summary] = await getMessageReactions(db, {
      maxUsersPerEmoji: 3,
      messageId,
    });

    expect(summary?.userIds).toHaveLength(3);
    expect(summary?.count).toBe(12);
  });

  it("keeps messages apart", async () => {
    const messageId = newTimeuuid();
    await addReaction(db, {
      emoji: { emoji: "🎉", kind: "unicode" },
      messageId,
      userId: newUuid().toString(),
    });

    expect(await getMessageReactions(db, { messageId: newTimeuuid() })).toEqual(
      []
    );
  });

  it("refuses a Unicode emoji that would parse back as a custom one", async () => {
    // Otherwise a client could forge a reference to a guild emoji it has no
    // access to, by naming it in the Unicode branch.
    await expect(
      addReaction(db, {
        emoji: { emoji: "custom:spoofed", kind: "unicode" },
        messageId: newTimeuuid(),
        userId: newUuid().toString(),
      })
    ).rejects.toThrow(COLLIDES);
  });
});
