import { and, db, eq, schema } from "@repo/db";

/**
 * Whether a user may subscribe to a topic.
 *
 * This is the security boundary of the gateway. `subscribe` is a request from
 * the client, and the client chooses the id -- so without a check here, any
 * authenticated user could subscribe to `events:guild:<anything>` and receive
 * every message, role change and member event in a guild they have never
 * joined. The socket is authenticated; it is not authorised.
 *
 * The checks fail closed. An unknown channel, a database error, a shape the
 * schema cannot express -- all deny.
 */

/**
 * Memberships are cached briefly, because `subscribe` arrives in bursts.
 *
 * A client reconnecting after a network blip re-subscribes to every guild and
 * channel it had open, which is one query per topic against `guild_members` at
 * the exact moment a deploy is reconnecting everyone at once.
 *
 * Five seconds is short enough that a kick takes effect almost immediately and
 * long enough to collapse a reconnect burst. It is a cache of a POSITIVE answer
 * only -- a denial is never cached, so granting access is never delayed.
 */
const CACHE_TTL_MS = 5000;
const cache = new Map<string, number>();

function cached(key: string): boolean {
  const until = cache.get(key);
  if (until === undefined) {
    return false;
  }
  if (until < Date.now()) {
    cache.delete(key);
    return false;
  }
  return true;
}

function remember(key: string): void {
  cache.set(key, Date.now() + CACHE_TTL_MS);
}

/**
 * A user's guild ids, cached on the same clock as the grants above.
 *
 * Separate from `cache` because it holds a list rather than a yes/no, and
 * because it is read on a different path -- once per connection, not once per
 * subscribe.
 */
const guildIds = new Map<string, { ids: string[]; until: number }>();

/** Drops a user's cached grants. Call when they are kicked or leave. */
export function forgetMemberships(userId: string): void {
  guildIds.delete(userId);
  for (const key of cache.keys()) {
    if (key.startsWith(`${userId}:`)) {
      cache.delete(key);
    }
  }
}

/**
 * Every guild the user belongs to.
 *
 * Read once per connection, to know where a presence change has to be
 * published. Served by `guild_members_user_id_idx` -- the primary key is
 * `(guild_id, user_id)`, so without that index this question would be a full
 * scan of every membership in the system.
 *
 * The result is cached for the same five seconds as the grants: a reconnect
 * storm after a deploy is thousands of clients asking this at once, and they
 * are asking about a list that changes when someone joins a guild, not
 * continuously.
 */
export async function guildIdsFor(userId: string): Promise<string[]> {
  const hit = guildIds.get(userId);
  if (hit && hit.until > Date.now()) {
    return hit.ids;
  }

  const rows = await db
    .select({ guildId: schema.guildMembers.guildId })
    .from(schema.guildMembers)
    .where(eq(schema.guildMembers.userId, userId));

  const ids = rows.map((row) => row.guildId);
  guildIds.set(userId, { ids, until: Date.now() + CACHE_TTL_MS });
  return ids;
}

export async function canAccessGuild(
  userId: string,
  guildId: string
): Promise<boolean> {
  const key = `${userId}:guild:${guildId}`;
  if (cached(key)) {
    return true;
  }

  const rows = await db
    .select({ userId: schema.guildMembers.userId })
    .from(schema.guildMembers)
    .where(
      and(
        eq(schema.guildMembers.guildId, guildId),
        eq(schema.guildMembers.userId, userId)
      )
    )
    .limit(1);

  const allowed = rows.length > 0;
  if (allowed) {
    remember(key);
  }
  return allowed;
}

/**
 * Whether a user may subscribe to a channel's events.
 *
 * Guild channels resolve to guild membership. DM channels currently DENY, and
 * that is a deliberate gap rather than an oversight: `channels.guild_id` is
 * null for a DM and there is no participant table, so there is nothing in
 * Postgres that says who is in a given DM. Allowing them would mean any
 * authenticated user could subscribe to any DM channel by id.
 *
 * Unblocking this needs a `channel_recipients` table (channel_id, user_id) and
 * one more branch here. Until then, DM events do not fan out over the gateway.
 */
export async function canAccessChannel(
  userId: string,
  channelId: string
): Promise<boolean> {
  const key = `${userId}:channel:${channelId}`;
  if (cached(key)) {
    return true;
  }

  const rows = await db
    .select({ guildId: schema.channels.guildId })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
    .limit(1);

  const guildId = rows[0]?.guildId;
  if (!guildId) {
    // Either the channel does not exist, or it is a DM. Both deny.
    return false;
  }

  const allowed = await canAccessGuild(userId, guildId);
  if (allowed) {
    remember(key);
  }
  return allowed;
}

export function canAccess(
  userId: string,
  scope: "channel" | "guild",
  id: string
): Promise<boolean> {
  return scope === "guild"
    ? canAccessGuild(userId, id)
    : canAccessChannel(userId, id);
}
