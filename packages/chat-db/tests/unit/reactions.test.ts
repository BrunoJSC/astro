import { describe, expect, it } from "bun:test";
import type { Client } from "cassandra-driver";
import { types } from "cassandra-driver";
import {
  addReaction,
  emojiKey,
  getMessageReactions,
  parseEmojiKey,
} from "../../src/reactions";

const COLLIDES = /collides/;
const CUSTOM_ID = "0b7d5b8e-4f2a-4a1d-9c3e-2f6a1b8c4d55";

/** Returns fixed rows and records every statement it was asked to run. */
function fakeClient(rows: Record<string, unknown>[]): {
  client: Client;
  calls: { params: unknown[]; query: string }[];
} {
  const calls: { params: unknown[]; query: string }[] = [];
  const client = {
    execute(query: string, params: unknown[]) {
      calls.push({ params, query });
      return Promise.resolve({ first: () => rows[0] ?? null, rows });
    },
  } as unknown as Client;
  return { calls, client };
}

describe("emojiKey / parseEmojiKey", () => {
  it("round-trips both kinds of emoji", () => {
    const unicode = { emoji: "🎉", kind: "unicode" } as const;
    const custom = { customEmojiId: CUSTOM_ID, kind: "custom" } as const;

    expect(parseEmojiKey(emojiKey(unicode))).toEqual(unicode);
    expect(parseEmojiKey(emojiKey(custom))).toEqual(custom);
  });

  it("never produces a null-equivalent key", () => {
    // The whole point of the single-column design: Cassandra rejects null in
    // clustering columns, so neither kind may encode to an absent value.
    expect(emojiKey({ emoji: "🔥", kind: "unicode" })).toBe("🔥");
    expect(emojiKey({ customEmojiId: CUSTOM_ID, kind: "custom" })).toBe(
      `custom:${CUSTOM_ID}`
    );
  });
});

describe("addReaction", () => {
  it("stores the custom id in the regular column too", async () => {
    const { calls, client } = fakeClient([]);
    await addReaction(client, {
      emoji: { customEmojiId: CUSTOM_ID, kind: "custom" },
      messageId: types.TimeUuid.now(),
      userId: "e1a2b3c4-0000-4000-8000-000000000001",
    });

    const [call] = calls;
    expect(call?.params[1]).toBe(`custom:${CUSTOM_ID}`);
    expect(call?.params[3]).toBe(CUSTOM_ID);
  });

  it("leaves custom_emoji_id null for a Unicode reaction", async () => {
    const { calls, client } = fakeClient([]);
    await addReaction(client, {
      emoji: { emoji: "🎉", kind: "unicode" },
      messageId: types.TimeUuid.now(),
      userId: "e1a2b3c4-0000-4000-8000-000000000001",
    });

    expect(calls[0]?.params[3]).toBeNull();
  });

  it("rejects a Unicode reaction that would parse back as custom", async () => {
    const { client } = fakeClient([]);
    await expect(
      addReaction(client, {
        emoji: { emoji: "custom:spoofed", kind: "unicode" },
        messageId: types.TimeUuid.now(),
        userId: "e1a2b3c4-0000-4000-8000-000000000001",
      })
    ).rejects.toThrow(COLLIDES);
  });
});

describe("getMessageReactions", () => {
  const messageId = types.TimeUuid.now();

  it("groups adjacent rows without re-sorting", async () => {
    const { client } = fakeClient([
      { custom_emoji_id: null, emoji_key: "🎉", user_id: "u1" },
      { custom_emoji_id: null, emoji_key: "🎉", user_id: "u2" },
      { custom_emoji_id: null, emoji_key: "🔥", user_id: "u3" },
    ]);

    const summaries = await getMessageReactions(client, { messageId });

    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.count).toBe(2);
    expect(summaries[0]?.emoji).toEqual({ emoji: "🎉", kind: "unicode" });
    expect(summaries[1]?.count).toBe(1);
  });

  it("keeps a Unicode emoji separate from a custom one", async () => {
    const { client } = fakeClient([
      {
        custom_emoji_id: CUSTOM_ID,
        emoji_key: `custom:${CUSTOM_ID}`,
        user_id: "u1",
      },
      { custom_emoji_id: null, emoji_key: "🎉", user_id: "u2" },
    ]);

    const summaries = await getMessageReactions(client, { messageId });

    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.emoji).toEqual({
      customEmojiId: CUSTOM_ID,
      kind: "custom",
    });
  });

  it("flags the viewer's own reaction", async () => {
    const { client } = fakeClient([
      { custom_emoji_id: null, emoji_key: "🎉", user_id: "u1" },
      { custom_emoji_id: null, emoji_key: "🎉", user_id: "u2" },
    ]);

    const summaries = await getMessageReactions(client, {
      messageId,
      viewerId: "u2",
    });

    expect(summaries[0]?.reactedByViewer).toBe(true);
  });

  it("caps retained user ids without distorting the count", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      custom_emoji_id: null,
      emoji_key: "🎉",
      user_id: `u${i}`,
    }));
    const { client } = fakeClient(rows);

    const summaries = await getMessageReactions(client, {
      maxUsersPerEmoji: 3,
      messageId,
    });

    expect(summaries[0]?.userIds).toHaveLength(3);
    expect(summaries[0]?.count).toBe(25);
  });
});
