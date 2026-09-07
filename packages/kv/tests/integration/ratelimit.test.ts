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
    /*
     * The bounds are MEASURED, not written down, and that is a fix rather than
     * a flourish. This test used to assert `retryAfterMs > 500` after a 300ms
     * sleep, which silently assumed the three round trips around it cost under
     * 200ms. Under a loaded machine they do not: it failed in CI-like
     * conditions with 453, and took the whole `turbo run test` down with it --
     * turbo SIGINTs the sibling tasks, so three other packages reported
     * exit 130 and the real failure was two screens up.
     *
     * `retryAfterMs` is `(oldestScore + window) - now`, and both halves come
     * from the CLIENT's clock -- `takeMessageSlot` passes `Date.now()` as
     * ARGV[1], the Lua never calls TIME. So this process can bracket it
     * exactly, with no tolerance to tune and nothing left to load.
     */
    const userId = newId();
    /*
     * A long window on purpose. The setup needs BOTH entries still inside it
     * when the third take runs; with a 1s window a stall between them ages the
     * first one out, the take is allowed, and the test fails for a reason that
     * has nothing to do with what it checks.
     */
    const options = { limit: 2, windowMs: 4000 };

    const beforeFirst = Date.now();
    await takeMessageSlot(kv, userId, options);
    const afterFirst = Date.now();

    await sleep(300);
    await takeMessageSlot(kv, userId, options);

    const beforeDenied = Date.now();
    const denied = await takeMessageSlot(kv, userId, options);
    const afterDenied = Date.now();

    expect(denied.allowed).toBe(false);

    /*
     * The oldest entry's score is somewhere in [beforeFirst, afterFirst], and
     * the denied call's `now` somewhere in [beforeDenied, afterDenied]. The
     * extremes of those two intervals bracket the answer.
     */
    const atMost = options.windowMs - (beforeDenied - afterFirst);
    const atLeast = options.windowMs - (afterDenied - beforeFirst);

    expect(denied.retryAfterMs).toBeLessThanOrEqual(atMost);
    expect(denied.retryAfterMs).toBeGreaterThanOrEqual(atLeast);

    // And the point of the test: a whole window would mean a fixed backoff.
    // The sleep guarantees the upper bound is strictly below one.
    expect(denied.retryAfterMs).toBeLessThan(options.windowMs);
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
    /*
     * A long window here for the same reason as above, in the opposite
     * direction: with a 1s one, a stall between the write and the read expires
     * the key, `pttl` answers -2, and the test fails claiming there is no TTL
     * when what it actually saw was the TTL working.
     */
    const windowMs = 60_000;
    const userId = newId();
    await takeMessageSlot(kv, userId, { limit: 5, windowMs });

    const ttl = await kv.pttl(rateLimitKey(userId));

    // -1 is "no expiry" and -2 is "no such key"; both are what this rejects.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(windowMs);
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
