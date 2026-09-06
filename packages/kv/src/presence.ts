import type { KvClient } from "./client";
import {
  userSocketKey,
  userSocketPrefix,
  userSocketsKey,
  userStatusKey,
} from "./keys";
import type {
  ClientType,
  Presence,
  PresenceSnapshot,
  PresenceState,
} from "./types";
import { CLIENT_TYPES, PRESENCE_STATES } from "./types";

/**
 * How long presence survives without a heartbeat.
 *
 * Sixty seconds is a deliberate multiple of the heartbeat interval, not a
 * timeout. At a 20s beat a user tolerates two consecutive lost beats -- a
 * train tunnel, a laptop lid, a garbage pause -- before appearing offline. Set
 * it equal to the interval and every hiccup flickers the user's status for
 * everyone watching.
 */
export const PRESENCE_TTL_SECONDS = 60;

/** Beat well inside the TTL, so one lost beat is never fatal. */
export const HEARTBEAT_INTERVAL_MS = 20_000;

export interface PresenceIdentity {
  socketId: string;
  userId: string;
}

export interface PresenceUpdate {
  clientType?: ClientType;
  customStatus?: string | null;
  state?: PresenceState;
}

/**
 * Announce a connection, or refresh one.
 *
 * Returns the number of live sockets. One means this was the user's first
 * connection and the transition to online is worth publishing; more means they
 * opened another device and nobody needs to be told again.
 */
export async function touchPresence(
  client: KvClient,
  identity: PresenceIdentity,
  update: PresenceUpdate = {},
  ttlSeconds = PRESENCE_TTL_SECONDS
): Promise<number> {
  const fields: string[] = [];

  if (update.state) {
    fields.push("state", update.state);
  }
  if (update.clientType) {
    fields.push("client_type", update.clientType);
  }
  if (update.customStatus !== undefined) {
    // Empty string, not a deleted field: HDEL would need a second command and
    // a missing field is indistinguishable from a key that partially expired.
    fields.push("custom_status", update.customStatus ?? "");
  }

  return await client.presenceTouch(
    userStatusKey(identity.userId),
    userSocketsKey(identity.userId),
    userSocketKey(identity.userId, identity.socketId),
    identity.socketId,
    ttlSeconds,
    Date.now(),
    ...fields
  );
}

/**
 * Close one socket cleanly.
 *
 * Returns the sockets that remain. Zero is the only value that means the user
 * went offline -- publishing an offline event on any other is the bug that
 * makes someone vanish from the member list because they closed one tab.
 */
export async function dropPresence(
  client: KvClient,
  identity: PresenceIdentity
): Promise<number> {
  return await client.presenceDrop(
    userStatusKey(identity.userId),
    userSocketsKey(identity.userId),
    userSocketKey(identity.userId, identity.socketId),
    identity.socketId
  );
}

/**
 * Drop socket ids whose owner stopped heartbeating.
 *
 * This is the recovery path for a WebSocket node that died without running its
 * disconnect handler. Nothing else notices: the user's other devices keep the
 * set alive, so the orphaned ids would otherwise never expire.
 *
 * Cheap enough to run on every heartbeat for the user being beaten, which is
 * how it is meant to be used -- the work is proportional to that one user's
 * device count, not to the keyspace.
 */
export async function reapDeadSockets(
  client: KvClient,
  userId: string
): Promise<{ remaining: number; removed: number }> {
  const [removed, remaining] = await client.presenceReap(
    userSocketsKey(userId),
    userSocketPrefix(userId)
  );
  return { remaining, removed };
}

/**
 * Presence for one user, or null when nothing is connected.
 *
 * Null is not "offline". A missing key means no socket is alive; `state:
 * "offline"` means the user chose to appear offline and is still connected.
 * Only the second should still receive events.
 */
export async function getPresence(
  client: KvClient,
  userId: string
): Promise<PresenceSnapshot> {
  const raw = await client.hgetall(userStatusKey(userId));
  return parsePresence(raw);
}

/**
 * Presence for many users in one round trip.
 *
 * A pipeline rather than a loop of awaits: the member list of a busy guild is
 * hundreds of users, and hundreds of sequential round trips is the difference
 * between a sidebar that renders and one that does not. Users with no live
 * socket are absent from the map rather than present as null, so the caller
 * cannot accidentally treat "offline" and "unknown" alike.
 */
export async function getPresences(
  client: KvClient,
  userIds: readonly string[]
): Promise<Map<string, Presence>> {
  const out = new Map<string, Presence>();
  if (userIds.length === 0) {
    return out;
  }

  const pipeline = client.pipeline();
  for (const userId of userIds) {
    pipeline.hgetall(userStatusKey(userId));
  }
  const results = await pipeline.exec();

  results?.forEach(([error, value], index) => {
    const userId = userIds[index];
    if (error || !userId) {
      return;
    }
    const presence = parsePresence(value as Record<string, string>);
    if (presence) {
      out.set(userId, presence);
    }
  });

  return out;
}

/** The live socket ids for a user, across every device. */
export async function getSockets(
  client: KvClient,
  userId: string
): Promise<string[]> {
  return await client.smembers(userSocketsKey(userId));
}

export interface HeartbeatHandle {
  /** Resolves once the loop has stopped and the final beat has settled. */
  stop: () => Promise<void>;
}

export interface HeartbeatOptions extends PresenceIdentity {
  intervalMs?: number;
  /** Called when a beat fails, so a node can log or tear the socket down. */
  onError?: (error: unknown) => void;
  /** Prune this user's dead sockets on each beat. Defaults to true. */
  reap?: boolean;
  ttlSeconds?: number;
}

/**
 * Keeps one socket's presence alive until it is stopped.
 *
 * Owned by the WebSocket connection, started when it opens and stopped in its
 * close handler -- `stop` also drops the socket, so a clean shutdown does not
 * wait out the TTL.
 *
 * `unref` is what keeps this from holding the process open: a server with an
 * interval per connection cannot exit while any of them is pending, and a
 * graceful shutdown would hang until the last client disconnected. The timer
 * still fires normally for as long as anything else keeps the loop alive.
 */
export function startHeartbeat(
  client: KvClient,
  options: HeartbeatOptions
): HeartbeatHandle {
  const identity = { socketId: options.socketId, userId: options.userId };
  const interval = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  let inFlight: Promise<unknown> = Promise.resolve();

  const timer = setInterval(() => {
    inFlight = beat().catch((error) => options.onError?.(error));
  }, interval);

  timer.unref?.();

  async function beat(): Promise<void> {
    await touchPresence(client, identity, {}, options.ttlSeconds);
    if (options.reap !== false) {
      await reapDeadSockets(client, options.userId);
    }
  }

  return {
    async stop() {
      clearInterval(timer);
      // Let a beat already on the wire settle before removing the socket, or
      // it lands after the DROP and resurrects presence for a full TTL.
      await inFlight.catch(() => {
        // Already reported through onError.
      });
      await dropPresence(client, identity);
    },
  };
}

function parsePresence(
  raw: Record<string, string> | null | undefined
): PresenceSnapshot {
  if (!raw || Object.keys(raw).length === 0) {
    return null;
  }

  const { client_type: clientType, state } = raw;

  return {
    clientType: isClientType(clientType) ? clientType : "web",
    customStatus: raw.custom_status ? raw.custom_status : null,
    // Redis returns every field as text. Number("") is 0, which would read as
    // 1970 rather than as missing, so the fallback is explicit.
    lastActive: raw.last_active ? Number(raw.last_active) : 0,
    state: isPresenceState(state) ? state : "online",
  };
}

function isPresenceState(value: string | undefined): value is PresenceState {
  return (
    value !== undefined &&
    (PRESENCE_STATES as readonly string[]).includes(value)
  );
}

function isClientType(value: string | undefined): value is ClientType {
  return (
    value !== undefined && (CLIENT_TYPES as readonly string[]).includes(value)
  );
}
