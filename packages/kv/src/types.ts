/**
 * The shapes stored in Redis and carried over pub/sub.
 *
 * Redis has no schema. Everything here is a value this package writes and reads
 * back as text, so these types are the only contract there is -- a field
 * renamed here and not in the writer is a silent undefined at the far end,
 * never a type error at the boundary.
 */

export const PRESENCE_STATES = ["online", "idle", "dnd", "offline"] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

export const CLIENT_TYPES = ["web", "desktop", "mobile"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

/**
 * `user:status:{id}` as it is read back.
 *
 * Every Redis hash field is a string on the wire; `lastActive` is parsed to a
 * number here so callers never do it themselves and never compare timestamps
 * lexicographically.
 */
export interface Presence {
  clientType: ClientType;
  customStatus: string | null;
  lastActive: number;
  state: PresenceState;
}

/**
 * A user with no live socket has NO status key at all -- it expired.
 *
 * That absence is the offline signal, and it is why `state: "offline"` is
 * distinct from a missing key: "offline" is a deliberate choice the user made
 * and is still connected under, while a missing key means nothing is connected.
 * Collapsing the two loses the ability to show an invisible user as invisible
 * to themselves.
 */
export type PresenceSnapshot = Presence | null;

export interface VoiceMemberState {
  joinedAt: number;
  peerId: string;
  selfDeaf: boolean;
  selfMute: boolean;
  serverDeaf: boolean;
  serverMute: boolean;
}

export interface VoiceMember extends VoiceMemberState {
  userId: string;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Requests still available in the current window. */
  remaining: number;
  /** Milliseconds until the window frees a slot. Zero when allowed. */
  retryAfterMs: number;
}

export interface TypingEntry {
  /** When this indicator stops on its own, in epoch milliseconds. */
  expiresAt: number;
  userId: string;
}

/* -------------------------------------------------------------------------
 * Pub/sub payloads
 *
 * Three scopes, three disjoint unions. They are kept separate rather than
 * merged into one big union because the scope decides who receives the event:
 * anything published to a guild channel reaches every member of that guild, so
 * a payload that belongs on a user channel must not be constructible for a
 * guild one. The types are what stop a private notification from being
 * broadcast by a typo.
 * ---------------------------------------------------------------------- */

interface EventBase {
  /**
   * The node that published this.
   *
   * Every WebSocket node subscribes to the channels its clients care about,
   * including the ones it publishes to -- so without this, a node re-delivers
   * its own events to sockets that already received them locally.
   */
  origin: string;
  /** Publish time, epoch milliseconds. */
  ts: number;
}

export type GuildEvent = EventBase &
  (
    | { channelId: string; messageId: string; type: "message.created" }
    | { memberId: string; type: "member.joined" }
    /*
     * Presence, fanned out to the guilds a user belongs to.
     *
     * Carries the whole snapshot rather than just the id, so a member list can
     * repaint from the event alone. Without it, every presence change in a
     * busy guild would become one `getPresence` per receiving client -- a read
     * storm proportional to members squared.
     */
    | { memberId: string; presence: Presence; type: "member.presence" }
    | { memberId: string; type: "member.left" }
    | { memberId: string; roleIds: readonly string[]; type: "member.roles" }
    | { roleId: string; type: "role.updated" }
  );

export type ChannelEvent = EventBase &
  (
    | { messageId: string; type: "message.deleted" }
    | { messageId: string; type: "message.updated" }
    | { messageId: string; userId: string; type: "reaction.added" }
    | { messageId: string; userId: string; type: "reaction.removed" }
    | { type: "typing.started"; userId: string }
    | { type: "voice.state"; state: VoiceMember }
  );

export type UserEvent = EventBase &
  (
    | { fromUserId: string; type: "friend.request" }
    | { fromUserId: string; type: "friend.accepted" }
    | { presence: Presence; type: "presence.updated" }
    | { channelId: string; messageId: string; type: "mention" }
  );

/** Maps a scope to the payloads it may carry. */
export interface EventMap {
  channel: ChannelEvent;
  guild: GuildEvent;
  user: UserEvent;
}

export type EventScope = keyof EventMap;
