/**
 * Every key this package touches, built in one place.
 *
 * ## The braces are real
 *
 * `user:status:{01931f...}` keeps the braces from the specified format instead
 * of substituting them away, and that is deliberate: in Redis Cluster a `{...}`
 * group is the HASH TAG, and only the text inside it is hashed to choose a
 * slot. So `user:status:{u}` and `user:sockets:{u}` land on the same node.
 *
 * That is not cosmetic. `touchPresence` writes to both keys in one Lua script,
 * and a script whose keys live in different slots is rejected outright with
 * CROSSSLOT -- not slowed down, rejected. The same applies to the typing pair:
 * `channel:typing:{c}:{u}` and its index `channel:typing:{c}` share the tag `c`
 * because Redis reads only the FIRST brace group.
 *
 * On a single node the braces are ordinary characters and cost nothing, so the
 * scheme is written once and works in both topologies.
 *
 * The ids themselves must not contain `{` or `}`; they are UUIDs, so they do
 * not, and `assertId` holds the line.
 */

const UNSAFE_ID = /[{}\s]/u;
const HASH_TAG = /\{([^{}]+)\}/u;

function tag(id: string): string {
  if (UNSAFE_ID.test(id) || id.length === 0) {
    throw new TypeError(
      `Not a usable id: "${id}". Braces and whitespace would break the hash tag.`
    );
  }
  return `{${id}}`;
}

export type UserStatusKey = `user:status:{${string}}`;
export type UserSocketsKey = `user:sockets:{${string}}`;
export type UserSocketKey = `user:socket:{${string}}:${string}`;
export type TypingKey = `channel:typing:{${string}}:${string}`;
export type TypingIndexKey = `channel:typing:{${string}}`;
export type VoiceMembersKey = `voice:channel:{${string}}:members`;
export type RateLimitKey = `ratelimit:msg:{${string}}`;

export type GuildEventChannel = `events:guild:{${string}}`;
export type ChannelEventChannel = `events:channel:{${string}}`;
export type UserEventChannel = `events:user:{${string}}`;

/** Hash. Presence fields, TTL renewed by heartbeat. */
export function userStatusKey(userId: string): UserStatusKey {
  return `user:status:${tag(userId)}` as UserStatusKey;
}

/** Set. One member per live socket, across every device. */
export function userSocketsKey(userId: string): UserSocketsKey {
  return `user:sockets:${tag(userId)}` as UserSocketsKey;
}

/**
 * String with the presence TTL, one per socket.
 *
 * The Set above is the roster; this is each member's own clock. A Set cannot
 * expire members individually, so without this a socket abandoned by a crashed
 * node is renewed forever by the user's other devices. See `PRESENCE_REAP`.
 */
export function userSocketKey(userId: string, socketId: string): UserSocketKey {
  return `user:socket:${tag(userId)}:${socketId}` as UserSocketKey;
}

/** The prefix `PRESENCE_REAP` rebuilds liveness keys from, inside Lua. */
export function userSocketPrefix(userId: string): string {
  return `user:socket:${tag(userId)}:`;
}

/**
 * String with a strict TTL: when it expires the user stops typing, with no
 * timer, no cleanup job and no event to miss.
 */
export function typingKey(channelId: string, userId: string): TypingKey {
  return `channel:typing:${tag(channelId)}:${userId}` as TypingKey;
}

/**
 * Sorted set indexing the keys above, scored by the moment each one expires.
 *
 * It exists because the per-user key alone cannot answer "who is typing in this
 * channel". Finding those keys means matching `channel:typing:{c}:*`, and the
 * only ways to do that are KEYS (blocks the server for the length of the whole
 * keyspace) and SCAN (a cursor over every key in the database, for an answer
 * needed on every keystroke). The index turns that into one ZRANGEBYSCORE.
 *
 * The string keys are still authoritative for expiry -- see `src/typing.ts`.
 */
export function typingIndexKey(channelId: string): TypingIndexKey {
  return `channel:typing:${tag(channelId)}` as TypingIndexKey;
}

/** Hash. Field = user id, value = JSON voice state. */
export function voiceMembersKey(channelId: string): VoiceMembersKey {
  return `voice:channel:${tag(channelId)}:members` as VoiceMembersKey;
}

/** Sorted set. Scores are send timestamps; the window slides over them. */
export function rateLimitKey(userId: string): RateLimitKey {
  return `ratelimit:msg:${tag(userId)}` as RateLimitKey;
}

export function guildEventChannel(guildId: string): GuildEventChannel {
  return `events:guild:${tag(guildId)}` as GuildEventChannel;
}

export function channelEventChannel(channelId: string): ChannelEventChannel {
  return `events:channel:${tag(channelId)}` as ChannelEventChannel;
}

export function userEventChannel(userId: string): UserEventChannel {
  return `events:user:${tag(userId)}` as UserEventChannel;
}

/**
 * The id back out of a key or pub/sub channel.
 *
 * Subscribers receive the channel name as a plain string, so the id has to be
 * recovered from it to route an event without a second lookup.
 */
export function idFromKey(key: string): string | null {
  const match = key.match(HASH_TAG);
  return match?.[1] ?? null;
}
