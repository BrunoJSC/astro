import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { KvClient } from "../../src/client";
import { typingIndexKey, typingKey } from "../../src/keys";
import { getTyping, startTyping, stopTyping } from "../../src/typing";
import { announceSkip, connectKv, newId, reachable, sleep } from "./helpers";

/**
 * Typing indicators, against a real server.
 *
 * The design rests on two things a fake cannot show: that the per-user key
 * really stops the indicator by expiring, with nothing scheduled anywhere, and
 * that the index really answers "who is typing here" without a keyspace scan.
 */

const CALLS = /calls=(\d+)/;

const available = await reachable();
if (!available) {
  announceSkip("kv/typing");
}

describe.skipIf(!available)("typing", () => {
  let kv: KvClient;

  beforeAll(async () => {
    kv = await connectKv();
  });

  afterAll(async () => {
    await kv?.flushdb();
    await kv?.quit();
  });

  it("lists who is typing, with the moment each one lapses", async () => {
    const channelId = newId();
    const alice = newId();
    const bob = newId();

    await startTyping(kv, channelId, alice);
    await startTyping(kv, channelId, bob);

    const typing = await getTyping(kv, channelId);

    expect(typing).toHaveLength(2);
    expect(typing.map((entry) => entry.userId).sort()).toEqual(
      [alice, bob].sort()
    );
    for (const entry of typing) {
      expect(entry.expiresAt).toBeGreaterThan(Date.now());
    }
  });

  it("stops on its own, with nothing scheduled anywhere", async () => {
    /*
     * The point of the TTL. No timer is held on any node, and a process that
     * dies mid-message cannot leave someone typing forever.
     */
    const channelId = newId();
    await startTyping(kv, channelId, newId(), 400);

    expect(await getTyping(kv, channelId)).toHaveLength(1);
    await sleep(600);
    expect(await getTyping(kv, channelId)).toHaveLength(0);
  });

  it("extends the window when the client keeps typing", async () => {
    const channelId = newId();
    const userId = newId();

    await startTyping(kv, channelId, userId, 500);
    await sleep(300);
    await startTyping(kv, channelId, userId, 500);
    await sleep(300);

    // Past the first window, inside the second.
    expect(await getTyping(kv, channelId)).toHaveLength(1);
  });

  it("gives the index a longer life than its entries", async () => {
    // The index has to outlive what it indexes, or an abandoned channel leaves
    // entries pointing at a key that is already gone.
    const channelId = newId();
    await startTyping(kv, channelId, newId(), 4000);

    const entry = await kv.pttl(typingKey(channelId, "x"));
    const index = await kv.pttl(typingIndexKey(channelId));

    expect(index).toBeGreaterThan(4000);
    // -2 is "no such key": the per-user key is namespaced by the real user id.
    expect(entry).toBe(-2);
  });

  it("prunes lapsed entries as part of the read", async () => {
    const channelId = newId();
    const quick = newId();
    const slow = newId();

    await startTyping(kv, channelId, quick, 300);
    await startTyping(kv, channelId, slow, 5000);
    await sleep(500);

    const typing = await getTyping(kv, channelId);

    expect(typing.map((entry) => entry.userId)).toEqual([slow]);
    // The prune is a real write, not a filter in the client: the lapsed member
    // is gone from the sorted set.
    expect(await kv.zcard(typingIndexKey(channelId))).toBe(1);
  });

  it("clears both keys on an explicit stop", async () => {
    const channelId = newId();
    const userId = newId();

    await startTyping(kv, channelId, userId);
    await stopTyping(kv, channelId, userId);

    expect(await getTyping(kv, channelId)).toHaveLength(0);
    expect(await kv.exists(typingKey(channelId, userId))).toBe(0);
  });

  it("keeps channels separate", async () => {
    const first = newId();
    const second = newId();
    const userId = newId();

    await startTyping(kv, first, userId);

    expect(await getTyping(kv, first)).toHaveLength(1);
    expect(await getTyping(kv, second)).toHaveLength(0);
  });

  it("answers with one command, never a keyspace scan", async () => {
    /*
     * The reason the index exists. Finding the per-user keys means matching
     * `channel:typing:{c}:*`, and both ways of doing that are unacceptable on a
     * path hit by every keystroke in every open channel: KEYS blocks the server
     * for the length of the whole keyspace, SCAN walks every key in the
     * database.
     */
    const channelId = newId();
    await startTyping(kv, channelId, newId());

    const before = await commandCount(kv, "scan");
    const keysBefore = await commandCount(kv, "keys");
    await getTyping(kv, channelId);

    expect(await commandCount(kv, "scan")).toBe(before);
    expect(await commandCount(kv, "keys")).toBe(keysBefore);
  });
});

/** How many times the server has executed a command since it started. */
async function commandCount(kv: KvClient, command: string): Promise<number> {
  const info = await kv.info("commandstats");
  const line = info
    .split("\n")
    .find((row) => row.startsWith(`cmdstat_${command}:`));

  return line ? Number(line.match(CALLS)?.[1] ?? 0) : 0;
}
