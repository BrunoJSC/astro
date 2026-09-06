import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Redis } from "ioredis";
import {
  rateLimitKey,
  typingIndexKey,
  typingKey,
  userSocketKey,
  userSocketsKey,
  userStatusKey,
  voiceMembersKey,
} from "../../src/keys";
import { newId, reachable } from "./helpers";

/**
 * Hash-tag co-location, answered by Redis itself.
 *
 * `tests/unit/keys.test.ts` reimplements CRC16/XMODEM to assert this without a
 * server, which is the right thing for a unit test and also the thing most
 * likely to be subtly wrong -- a reimplementation that agrees with itself
 * proves nothing. `CLUSTER KEYSLOT` asks the server, so the two together mean
 * the design holds and the reimplementation matches it.
 *
 * The claim under test: `PRESENCE_TOUCH` writes three keys in one Lua script,
 * and a script whose keys span slots is rejected outright with CROSSSLOT.
 *
 * Needs an instance started with `--cluster-enabled yes`; a standalone server
 * answers `This instance has cluster support disabled`. The compose file has
 * one on 6380 for exactly this.
 */

const CLUSTER_URL = process.env.REDIS_CLUSTER_URL ?? "redis://localhost:6380";

const available = await reachable(CLUSTER_URL);
if (!available) {
  process.stderr.write(
    `\n[kv/cluster-slots] skipped: no cluster-enabled Redis at ${CLUSTER_URL}.\n` +
      "  cd packages/kv && bun run kv:up\n\n"
  );
}

describe.skipIf(!available)("cluster hash tags", () => {
  let redis: Redis;
  /** A single node answers KEYSLOT without belonging to a real cluster. */
  const slot = (key: string) =>
    redis.cluster("KEYSLOT", key) as Promise<number>;

  beforeAll(() => {
    redis = new Redis(CLUSTER_URL);
  });

  afterAll(() => {
    redis?.disconnect();
  });

  it("puts a user's three presence keys in one slot", async () => {
    const userId = newId();

    const slots = await Promise.all([
      slot(userStatusKey(userId)),
      slot(userSocketsKey(userId)),
      slot(userSocketKey(userId, "socket-a")),
    ]);

    // The whole reason PRESENCE_TOUCH can be a single script.
    expect(new Set(slots).size).toBe(1);
  });

  it("puts a channel's typing keys in one slot", async () => {
    // Redis reads only the FIRST brace group, so the per-user key is tagged by
    // the channel even though a user id follows it.
    const channelId = newId();

    expect(await slot(typingKey(channelId, newId()))).toBe(
      await slot(typingIndexKey(channelId))
    );
  });

  it("would scatter the same keys without the braces", async () => {
    // The control. If this ever fails, the hash tags stopped doing anything
    // and every multi-key script here is one deploy from breaking.
    const userId = newId();

    const [status, sockets] = await Promise.all([
      slot(`user:status:${userId}`),
      slot(`user:sockets:${userId}`),
    ]);

    expect(status).not.toBe(sockets);
  });

  it("spreads unrelated users across the keyspace", async () => {
    // Co-location must not become one hot slot for everybody.
    const slots = await Promise.all(
      Array.from({ length: 30 }, () => slot(userStatusKey(newId())))
    );

    // 30 random ids over 16384 slots: collisions are possible, a single slot
    // is not.
    expect(new Set(slots).size).toBeGreaterThan(25);
  });

  it("keeps every key family inside its own id's slot", async () => {
    const id = newId();

    const [voice, rate, typing] = await Promise.all([
      slot(voiceMembersKey(id)),
      slot(rateLimitKey(id)),
      slot(typingIndexKey(id)),
    ]);

    // Different key families, same tagged id, so they share a node. Nothing
    // depends on this today, but a future script spanning two of them can.
    expect(new Set([voice, rate, typing]).size).toBe(1);
  });
});
