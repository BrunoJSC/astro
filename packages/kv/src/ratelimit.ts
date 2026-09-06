import { randomUUID } from "node:crypto";
import type { KvClient } from "./client";
import { rateLimitKey } from "./keys";
import type { RateLimitResult } from "./types";

/** Discord's own default for a normal channel: five messages per five seconds. */
export const MESSAGE_RATE_LIMIT = 5;
export const MESSAGE_RATE_WINDOW_MS = 5000;

/**
 * Take one slot from a user's message budget.
 *
 * A sliding window over a sorted set, not a fixed counter with a TTL. A fixed
 * window lets a user send the whole budget in the last instant of one window
 * and the whole budget again in the first instant of the next -- double the
 * limit, back to back, which is exactly the burst this is meant to stop. The
 * ZSET holds one entry per send and the window slides continuously over them.
 *
 * The decision happens inside a Lua script. Read the count here and add there
 * and two concurrent sockets both see room and both write.
 *
 * The member token is random per attempt for a reason worth knowing: a ZSET
 * member is unique, so two sends in the same millisecond written under the same
 * member would collapse into one entry and count once. A user could then exceed
 * the limit by being fast enough -- the precise thing being defended against.
 */
export async function takeMessageSlot(
  client: KvClient,
  userId: string,
  options: { limit?: number; windowMs?: number } = {}
): Promise<RateLimitResult> {
  const limit = options.limit ?? MESSAGE_RATE_LIMIT;
  const windowMs = options.windowMs ?? MESSAGE_RATE_WINDOW_MS;

  const [allowed, remaining, retryAfterMs] = await client.ratelimitTake(
    rateLimitKey(userId),
    Date.now(),
    windowMs,
    limit,
    randomUUID()
  );

  return {
    allowed: allowed === 1,
    remaining,
    retryAfterMs,
  };
}

/**
 * What a user has left, without spending anything.
 *
 * Lapsed entries are not pruned here -- this is a read, and pruning would make
 * a status check a write on every call. The count can therefore be slightly
 * pessimistic for entries that have just aged out; `takeMessageSlot` prunes
 * before it decides, so the number that gates a send is always exact.
 */
export async function peekMessageBudget(
  client: KvClient,
  userId: string,
  options: { limit?: number; windowMs?: number } = {}
): Promise<number> {
  const limit = options.limit ?? MESSAGE_RATE_LIMIT;
  const windowMs = options.windowMs ?? MESSAGE_RATE_WINDOW_MS;

  const used = await client.zcount(
    rateLimitKey(userId),
    Date.now() - windowMs,
    "+inf"
  );

  return Math.max(0, limit - used);
}

/** Clears a user's window. For moderation tooling and tests, not the hot path. */
export async function resetMessageBudget(
  client: KvClient,
  userId: string
): Promise<void> {
  await client.del(rateLimitKey(userId));
}
