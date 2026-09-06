import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { KvClient } from "../../src/client";
import { rateLimitKey } from "../../src/keys";
import {
  MESSAGE_RATE_LIMIT,
  peekMessageBudget,
  resetMessageBudget,
  takeMessageSlot,
} from "../../src/ratelimit";
import type { RateLimitResult } from "../../src/types";
import { announceSkip, connectKv, newId, reachable, sleep } from "./helpers";

/**
 * The sliding window, against a real server.
 *
 * This is the file the unit tests cannot substitute for. A limiter is only
 * worth anything under concurrency, and concurrency is exactly what a fake
 * client cannot reproduce -- it answers instantly and in order.
 */

const available = await reachable();
if (!available) {
  announceSkip("kv/ratelimit");
}

const WINDOW = 1000;

describe.skipIf(!available)("rate limiting", () => {
  let kv: KvClient;

  beforeAll(async () => {
    kv = await connectKv();
  });

  afterAll(async () => {
    await kv?.flushdb();
    await kv?.quit();
  });

  it("allows exactly the limit, then refuses", async () => {
    const userId = newId();
    const options = { limit: 5, windowMs: WINDOW };

    // Sequential on purpose: this asserts the budget counts DOWN, which only
    // means something in order. The concurrent cases are separate tests below.
    const taken: RateLimitResult[] = [];
    for (let i = 0; i < 5; i += 1) {
      taken.push(await takeMessageSlot(kv, userId, options));
    }

    expect(taken.every((result) => result.allowed)).toBe(true);
    expect(taken.map((result) => result.remaining)).toEqual([4, 3, 2, 1, 0]);

    const denied = await takeMessageSlot(kv, userId, options);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it("reports when the window frees a slot, not a fixed backoff", async () => {
    const userId = newId();
    const options = { limit: 2, windowMs: WINDOW };

    await takeMessageSlot(kv, userId, options);
    await sleep(300);
    await takeMessageSlot(kv, userId, options);

    const denied = await takeMessageSlot(kv, userId, options);

    // Derived from the oldest surviving entry: ~700ms left of its window, not
    // a whole window and not a constant.
    expect(denied.retryAfterMs).toBeGreaterThan(500);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(WINDOW);
  });

  it("slides rather than resetting on a boundary", async () => {
    /*
     * The failure a fixed window has: spend the whole budget at the end of one
     * window and the whole budget again at the start of the next, which is
     * double the limit back to back. Here the entries age out individually.
     */
    const userId = newId();
    const options = { limit: 3, windowMs: 600 };

    await takeMessageSlot(kv, userId, options);
    await takeMessageSlot(kv, userId, options);
    await takeMessageSlot(kv, userId, options);
    expect((await takeMessageSlot(kv, userId, options)).allowed).toBe(false);

    await sleep(700);

    // The window has moved past all three, so the budget is whole again --
    // gradually, as each entry ages out, not in a step at a clock boundary.
    expect((await takeMessageSlot(kv, userId, options)).allowed).toBe(true);
  });

  it("cannot be beaten by sending faster than the clock", async () => {
    /*
     * The token test, and the reason every attempt writes a random ZSET
     * member. A ZSET member is unique: twenty sends landing in the same
     * millisecond under a shared member would collapse into one entry and be
     * counted once, letting a client exceed the limit by being quick.
     */
    const userId = newId();
    const options = { limit: 5, windowMs: WINDOW };

    const burst = await Promise.all(
      Array.from({ length: 20 }, () => takeMessageSlot(kv, userId, options))
    );

    expect(burst.filter((result) => result.allowed)).toHaveLength(5);
    expect(await kv.zcard(rateLimitKey(userId))).toBe(5);
  });

  it("never lets two concurrent takers past the last slot", async () => {
    // The read-then-write race the Lua script exists to close. Done from the
    // client, both callers see a count under the limit and both add.
    const userId = newId();
    const options = { limit: 1, windowMs: WINDOW };

    const results = await Promise.all([
      takeMessageSlot(kv, userId, options),
      takeMessageSlot(kv, userId, options),
      takeMessageSlot(kv, userId, options),
    ]);

    expect(results.filter((result) => result.allowed)).toHaveLength(1);
  });

  it("keeps users apart", async () => {
    const first = newId();
    const second = newId();
    const options = { limit: 1, windowMs: WINDOW };

    await takeMessageSlot(kv, first, options);

    expect((await takeMessageSlot(kv, first, options)).allowed).toBe(false);
    expect((await takeMessageSlot(kv, second, options)).allowed).toBe(true);
  });

  it("expires the window key rather than keeping it forever", async () => {
    const userId = newId();
    await takeMessageSlot(kv, userId, { limit: 5, windowMs: WINDOW });

    const ttl = await kv.pttl(rateLimitKey(userId));

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(WINDOW);
  });

  it("peeks without spending", async () => {
    const userId = newId();
    await takeMessageSlot(kv, userId, { limit: 5, windowMs: WINDOW });

    expect(await peekMessageBudget(kv, userId, { limit: 5 })).toBe(4);
    expect(await peekMessageBudget(kv, userId, { limit: 5 })).toBe(4);
  });

  it("never reports a negative budget", async () => {
    const userId = newId();
    for (let i = 0; i < 3; i += 1) {
      await takeMessageSlot(kv, userId, { limit: 3, windowMs: WINDOW });
    }

    expect(await peekMessageBudget(kv, userId, { limit: 1 })).toBe(0);
  });

  it("resets a user's window", async () => {
    const userId = newId();
    for (let i = 0; i < MESSAGE_RATE_LIMIT; i += 1) {
      await takeMessageSlot(kv, userId);
    }
    expect((await takeMessageSlot(kv, userId)).allowed).toBe(false);

    await resetMessageBudget(kv, userId);

    expect((await takeMessageSlot(kv, userId)).allowed).toBe(true);
  });
});
