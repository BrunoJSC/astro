import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { KvClient } from "../../src/client";
import { userSocketKey, userSocketsKey, userStatusKey } from "../../src/keys";
import {
  dropPresence,
  getPresence,
  getPresences,
  getSockets,
  PRESENCE_TTL_SECONDS,
  reapDeadSockets,
  startHeartbeat,
  touchPresence,
} from "../../src/presence";
import { announceSkip, connectKv, newId, reachable, sleep } from "./helpers";

/**
 * Presence, against a real server.
 *
 * `PRESENCE_TOUCH`, `PRESENCE_DROP` and `PRESENCE_REAP` are Lua. Their whole
 * value is that they are one atomic unit, and that is not observable from a
 * fake -- the unit tests can only check which arguments were sent.
 */

const available = await reachable();
if (!available) {
  announceSkip("kv/presence");
}

describe.skipIf(!available)("presence", () => {
  let kv: KvClient;

  beforeAll(async () => {
    kv = await connectKv();
  });

  afterAll(async () => {
    await kv?.flushdb();
    await kv?.quit();
  });

  it("counts sockets as devices connect", async () => {
    const userId = newId();

    expect(
      await touchPresence(kv, { socketId: "s1", userId }, { state: "online" })
    ).toBe(1);
    expect(await touchPresence(kv, { socketId: "s2", userId })).toBe(2);
    expect(await touchPresence(kv, { socketId: "s3", userId })).toBe(3);

    // Re-touching an existing socket is idempotent, not a fourth device.
    expect(await touchPresence(kv, { socketId: "s2", userId })).toBe(3);
  });

  it("round-trips every field through the hash", async () => {
    const userId = newId();
    await touchPresence(
      kv,
      { socketId: "s1", userId },
      { clientType: "desktop", customStatus: "shipping", state: "idle" }
    );

    const presence = await getPresence(kv, userId);

    expect(presence).toMatchObject({
      clientType: "desktop",
      customStatus: "shipping",
      state: "idle",
    });
    // Redis returns every field as text; the wrapper is what makes it a number.
    expect(typeof presence?.lastActive).toBe("number");
    expect(presence?.lastActive).toBeGreaterThan(1_700_000_000_000);
  });

  it("returns null for a user with nothing connected", async () => {
    // Absence is the offline signal. It is NOT `state: "offline"`, which means
    // the user chose to appear offline and is still receiving events.
    expect(await getPresence(kv, newId())).toBeNull();
  });

  it("puts a TTL on all three keys", async () => {
    const userId = newId();
    await touchPresence(kv, { socketId: "s1", userId });

    const [status, sockets, liveness] = await Promise.all([
      kv.ttl(userStatusKey(userId)),
      kv.ttl(userSocketsKey(userId)),
      kv.ttl(userSocketKey(userId, "s1")),
    ]);

    // A key with no TTL reports -1, a missing key -2. Neither is acceptable:
    // a presence key without one is a leak that shows up months later.
    for (const ttl of [status, sockets, liveness]) {
      expect(ttl).toBeGreaterThan(PRESENCE_TTL_SECONDS - 5);
      expect(ttl).toBeLessThanOrEqual(PRESENCE_TTL_SECONDS);
    }
  });

  it("pushes the TTL back out on a heartbeat", async () => {
    const userId = newId();
    // A short TTL so the decay is observable without a slow test.
    await touchPresence(kv, { socketId: "s1", userId }, {}, 5);
    await sleep(1100);

    const decayed = await kv.ttl(userStatusKey(userId));
    expect(decayed).toBeLessThanOrEqual(4);

    await touchPresence(kv, { socketId: "s1", userId }, {}, 5);
    expect(await kv.ttl(userStatusKey(userId))).toBeGreaterThan(decayed);
  });

  it("expires everything when heartbeats stop", async () => {
    const userId = newId();
    await touchPresence(kv, { socketId: "s1", userId }, {}, 1);
    await sleep(1400);

    expect(await getPresence(kv, userId)).toBeNull();
    expect(await getSockets(kv, userId)).toEqual([]);
  });
});

describe.skipIf(!available)("dead socket reaping", () => {
  let kv: KvClient;

  beforeAll(async () => {
    kv = await connectKv();
  });

  afterAll(async () => {
    await kv?.flushdb();
    await kv?.quit();
  });

  it("keeps an orphaned socket alive without the reaper", async () => {
    /*
     * The failure the liveness key exists for. A Set cannot expire members: as
     * long as one socket keeps heartbeating, the whole key's TTL is renewed,
     * including the id a crashed node left behind.
     */
    const userId = newId();
    await touchPresence(kv, { socketId: "alive", userId });
    await touchPresence(kv, { socketId: "crashed", userId });

    // The crashed node's liveness key expires; its Set member does not.
    await kv.del(userSocketKey(userId, "crashed"));
    await touchPresence(kv, { socketId: "alive", userId });

    expect(await kv.scard(userSocketsKey(userId))).toBe(2);
  });

  it("removes exactly the sockets whose liveness key is gone", async () => {
    const userId = newId();
    await touchPresence(kv, { socketId: "alive", userId });
    await touchPresence(kv, { socketId: "crashed", userId });
    await kv.del(userSocketKey(userId, "crashed"));

    expect(await reapDeadSockets(kv, userId)).toEqual({
      remaining: 1,
      removed: 1,
    });
    expect(await getSockets(kv, userId)).toEqual(["alive"]);
  });

  it("does nothing when every socket is live", async () => {
    const userId = newId();
    await touchPresence(kv, { socketId: "s1", userId });
    await touchPresence(kv, { socketId: "s2", userId });

    expect(await reapDeadSockets(kv, userId)).toEqual({
      remaining: 2,
      removed: 0,
    });
  });
});

describe.skipIf(!available)("disconnect", () => {
  let kv: KvClient;

  beforeAll(async () => {
    kv = await connectKv();
  });

  afterAll(async () => {
    await kv?.flushdb();
    await kv?.quit();
  });

  it("keeps presence alive while another device holds it", async () => {
    const userId = newId();
    await touchPresence(kv, { socketId: "s1", userId }, { state: "online" });
    await touchPresence(kv, { socketId: "s2", userId });

    expect(await dropPresence(kv, { socketId: "s2", userId })).toBe(1);
    expect(await getPresence(kv, userId)).not.toBeNull();
  });

  it("tears everything down when the last socket goes", async () => {
    const userId = newId();
    await touchPresence(kv, { socketId: "s1", userId }, { state: "online" });

    expect(await dropPresence(kv, { socketId: "s1", userId })).toBe(0);
    expect(await getPresence(kv, userId)).toBeNull();
    // The set is deleted too, not left as an empty key.
    expect(await kv.exists(userSocketsKey(userId))).toBe(0);
  });

  it("drops the socket's own liveness key", async () => {
    const userId = newId();
    await touchPresence(kv, { socketId: "s1", userId });
    await touchPresence(kv, { socketId: "s2", userId });
    await dropPresence(kv, { socketId: "s1", userId });

    expect(await kv.exists(userSocketKey(userId, "s1"))).toBe(0);
    expect(await kv.exists(userSocketKey(userId, "s2"))).toBe(1);
  });
});

describe.skipIf(!available)("concurrency", () => {
  let kv: KvClient;

  beforeAll(async () => {
    kv = await connectKv();
  });

  afterAll(async () => {
    await kv?.flushdb();
    await kv?.quit();
  });

  it("counts twenty simultaneous connections exactly", async () => {
    /*
     * The reason PRESENCE_TOUCH is Lua. SADD, EXPIRE and SCARD issued
     * separately would interleave under this, and the count each socket saw
     * would be whatever the others had reached -- so several would believe
     * they were the first connection and all announce it.
     */
    const userId = newId();

    const counts = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        touchPresence(kv, { socketId: `s${i}`, userId })
      )
    );

    expect(await kv.scard(userSocketsKey(userId))).toBe(20);
    // Exactly one caller can be told it is the first.
    expect(counts.filter((count) => count === 1)).toHaveLength(1);
    expect(new Set(counts).size).toBe(20);
  });

  it("has exactly one concurrent disconnect see zero", async () => {
    const userId = newId();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        touchPresence(kv, { socketId: `s${i}`, userId })
      )
    );

    const remaining = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        dropPresence(kv, { socketId: `s${i}`, userId })
      )
    );

    // Only one socket may be told it was the last, or the offline event fires
    // several times.
    expect(remaining.filter((count) => count === 0)).toHaveLength(1);
  });
});

describe.skipIf(!available)("getPresences", () => {
  let kv: KvClient;

  beforeAll(async () => {
    kv = await connectKv();
  });

  afterAll(async () => {
    await kv?.flushdb();
    await kv?.quit();
  });

  it("reads a whole member list in one pipeline", async () => {
    const online = Array.from({ length: 50 }, () => newId());
    const offline = Array.from({ length: 10 }, () => newId());

    await Promise.all(
      online.map((userId) =>
        touchPresence(kv, { socketId: "s1", userId }, { state: "online" })
      )
    );

    const presences = await getPresences(kv, [...online, ...offline]);

    expect(presences.size).toBe(50);
    // Users with nothing connected are ABSENT, not mapped to null -- so a
    // caller cannot confuse "offline" with "unknown".
    for (const userId of offline) {
      expect(presences.has(userId)).toBe(false);
    }
  });

  it("touches the network not at all for an empty list", async () => {
    expect((await getPresences(kv, [])).size).toBe(0);
  });
});

describe.skipIf(!available)("startHeartbeat", () => {
  let kv: KvClient;

  beforeAll(async () => {
    kv = await connectKv();
  });

  afterAll(async () => {
    await kv?.flushdb();
    await kv?.quit();
  });

  it("keeps a socket alive past its TTL, then drops it on stop", async () => {
    const userId = newId();
    const handle = startHeartbeat(kv, {
      intervalMs: 300,
      socketId: "s1",
      ttlSeconds: 1,
      userId,
    });

    // Well past the 1s TTL: without the beat the key would be gone by now.
    await sleep(1600);
    expect(await getPresence(kv, userId)).not.toBeNull();

    await handle.stop();

    // `stop` drops the socket rather than waiting out the TTL.
    expect(await getPresence(kv, userId)).toBeNull();
  });
});
