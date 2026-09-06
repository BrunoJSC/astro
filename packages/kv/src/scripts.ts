/**
 * Lua, because these operations are read-then-write.
 *
 * A sliding-window rate limiter written as ZREMRANGEBYSCORE / ZCARD / ZADD from
 * the client leaks under exactly the load it exists to stop: two sockets both
 * read a count under the limit and both add, so the limit is exceeded by as
 * many concurrent requests as there are. MULTI does not fix it either -- it
 * batches commands, it does not let a decision inside the batch depend on a
 * value read within it. Lua runs on the server, single-threaded, start to
 * finish, which is the only place that decision can be made safely.
 *
 * The same reasoning covers dropping the last socket: SREM, SCARD and DEL have
 * to see one consistent view or a reconnect racing a disconnect deletes the
 * presence of a user who is still online.
 */

/**
 * Refresh presence and record the socket. One round trip, one atomic unit.
 *
 * KEYS[1] status hash, KEYS[2] socket set, KEYS[3] this socket's liveness key.
 * ARGV[1] socket id, ARGV[2] ttl seconds, ARGV[3] now (ms),
 * ARGV[4..] optional field/value pairs for the hash.
 *
 * All three keys get the TTL, and the third one is why.
 *
 * A Set has no per-member expiry: EXPIRE applies to the whole key. So while
 * any one socket keeps heartbeating, the set's TTL keeps being renewed -- and
 * a socket id left behind by a node that crashed is renewed along with it,
 * forever. The user shows as online from a laptop that has been shut for a
 * week, and no amount of waiting fixes it, because something IS still alive.
 *
 * The liveness key gives each socket its own clock. The set stays the roster;
 * `PRESENCE_REAP` compares the two and drops what no longer exists.
 *
 * Returns the number of live sockets, which is what tells the caller whether
 * this was the user's first connection and therefore worth announcing.
 */
export const PRESENCE_TOUCH = `
local ttl = tonumber(ARGV[2])

redis.call('SADD', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], ttl)
redis.call('SET', KEYS[3], ARGV[3], 'EX', ttl)

if #ARGV > 3 then
  local fields = {}
  for i = 4, #ARGV do
    fields[#fields + 1] = ARGV[i]
  end
  redis.call('HSET', KEYS[1], unpack(fields))
end

redis.call('HSET', KEYS[1], 'last_active', ARGV[3])
redis.call('EXPIRE', KEYS[1], ttl)

return redis.call('SCARD', KEYS[2])
`;

/**
 * Remove one socket, and tear presence down only when it was the last.
 *
 * KEYS[1] status hash, KEYS[2] socket set, KEYS[3] liveness key.
 * ARGV[1] socket id.
 *
 * Returns how many sockets remain. Zero means the user really went offline;
 * anything else means they closed one tab and are still here on another
 * device, and no offline event should be published.
 */
export const PRESENCE_DROP = `
redis.call('SREM', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
local remaining = redis.call('SCARD', KEYS[2])

if remaining == 0 then
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[2])
end

return remaining
`;

/**
 * Drop socket ids whose owner stopped heartbeating.
 *
 * KEYS[1] socket set. ARGV[1] the liveness key prefix for this user.
 *
 * The liveness keys are built inside the script rather than passed in, which
 * normally breaks Redis Cluster -- a script may only touch keys it declared.
 * It is safe here for one specific reason: every key involved carries the same
 * `{user_id}` hash tag, so all of them hash to the same slot and the script
 * never reaches across nodes. Change the key scheme and this stops being true.
 *
 * Returns {removed, remaining}.
 */
export const PRESENCE_REAP = `
local members = redis.call('SMEMBERS', KEYS[1])
local removed = 0

for i = 1, #members do
  if redis.call('EXISTS', ARGV[1] .. members[i]) == 0 then
    redis.call('SREM', KEYS[1], members[i])
    removed = removed + 1
  end
end

return {removed, redis.call('SCARD', KEYS[1])}
`;

/**
 * Sliding-window take.
 *
 * KEYS[1] the zset. ARGV[1] now (ms), ARGV[2] window (ms), ARGV[3] limit,
 * ARGV[4] a unique member token.
 *
 * The token matters. Scores alone do not identify a member, so two messages
 * sent in the same millisecond would write the same member twice -- and a ZSET
 * keeps one, silently counting two sends as one. The caller passes something
 * unique per attempt.
 *
 * Returns {allowed, remaining, retryAfterMs}. `retryAfterMs` is derived from
 * the oldest surviving entry: that is the moment the window slides past it and
 * frees the slot, which is a real answer rather than a fixed backoff.
 */
export const RATELIMIT_TAKE = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local used = redis.call('ZCARD', KEYS[1])

if used >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local retry = 0
  if oldest[2] then
    retry = (tonumber(oldest[2]) + window) - now
    if retry < 0 then retry = 0 end
  end
  return {0, 0, retry}
end

redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], window)

return {1, limit - used - 1, 0}
`;

/**
 * Start or extend a typing indicator.
 *
 * KEYS[1] the per-user string, KEYS[2] the channel index.
 * ARGV[1] user id, ARGV[2] now (ms), ARGV[3] ttl (ms).
 *
 * Both are written because they answer different questions. The string expires
 * on its own, which is what makes typing stop with no timer anywhere; the
 * index is what makes "who is typing here" answerable without scanning the
 * keyspace. The index gets twice the TTL so it survives its own entries and an
 * abandoned channel still cleans itself up.
 */
export const TYPING_START = `
local ttl = tonumber(ARGV[3])
local now = tonumber(ARGV[2])

redis.call('SET', KEYS[1], ARGV[1], 'PX', ttl)
redis.call('ZADD', KEYS[2], now + ttl, ARGV[1])
redis.call('PEXPIRE', KEYS[2], ttl * 2)

return 1
`;

/**
 * Who is typing, dropping anyone whose indicator has lapsed.
 *
 * KEYS[1] the channel index. ARGV[1] now (ms).
 *
 * The prune happens here rather than in a background job: the read is the only
 * moment anyone cares, and it is cheap because ZREMRANGEBYSCORE only touches
 * the entries that actually expired.
 */
export const TYPING_LIST = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
return redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
`;

/** KEYS[1] the per-user string, KEYS[2] the index. ARGV[1] user id. */
export const TYPING_STOP = `
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

/**
 * Join or update a voice member, returning the resulting roster size.
 *
 * KEYS[1] the members hash. ARGV[1] user id, ARGV[2] JSON state.
 */
export const VOICE_JOIN = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return redis.call('HLEN', KEYS[1])
`;

/**
 * KEYS[1] the members hash. ARGV[1] user id.
 *
 * Deletes the hash when the last member leaves. An empty hash is not the same
 * as an absent one to anything that lists active voice channels, and Redis
 * keeps a zero-field hash around as a real key.
 */
export const VOICE_LEAVE = `
redis.call('HDEL', KEYS[1], ARGV[1])
local remaining = redis.call('HLEN', KEYS[1])

if remaining == 0 then
  redis.call('DEL', KEYS[1])
end

return remaining
`;
