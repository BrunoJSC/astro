import {
  getTyping,
  getVoiceMembers,
  joinVoice,
  type KvClient,
  leaveVoice,
  publishEvent,
  startTyping,
  stopTyping,
  takeMessageSlot,
  touchPresence,
  updateVoiceState,
} from "@repo/kv";
import { canAccess } from "./authorize";
import type { ClientFrame, ServerFrame } from "./model";
import type { GatewayRegistry, GatewaySocket } from "./registry";

/**
 * One function per client frame.
 *
 * They live here rather than inline in the `message` switch because that switch
 * became one function holding every branch of the protocol -- nine operations,
 * each with its own authorisation, rate limit and publish. Split out, each one
 * is readable on its own and testable without a socket.
 */

/** Sent when a client closes without a valid session. */
export const UNAUTHORISED = 4001;

/**
 * How often a client may publish a typing indicator for one channel.
 *
 * In process, and before the rate limiter, because typing is the one frame a
 * client sends on a keystroke. The Redis key has an 8-second TTL, so re-sending
 * every 3 seconds keeps the indicator alive with room to spare -- and the frames
 * in between are dropped here rather than becoming a publish each, which would
 * fan out to every socket in the channel on every node.
 */
export const TYPING_THROTTLE_MS = 3000;

export interface Sender {
  send: (payload: never) => unknown;
}

export interface SocketState {
  /** Read once at connect, so a disconnect needs no query. */
  guildIds: readonly string[];
  socket: GatewaySocket;
  /** Last publish per channel, for the typing throttle. */
  typingAt: Map<string, number>;
}

export interface FrameContext {
  commands: KvClient;
  /** The user's guilds, read once at connect. See `publishPresence`. */
  guildIds: readonly string[];
  nodeId: string;
  now: number;
  registry: GatewayRegistry;
  state: SocketState;
  userId: string;
  ws: Sender;
}

/** One place that serialises, so the wire format cannot drift per call site. */
export function send(ws: Sender, frame: ServerFrame): void {
  ws.send(JSON.stringify(frame) as never);
}

function deny(ws: Sender, message: string): void {
  send(ws, { code: "forbidden", message, op: "error" });
}

/**
 * Spends one slot of the user's write budget, or refuses the frame.
 *
 * The budget is shared with sending a message, deliberately: both are the same
 * user writing, and a client should not get a fresh allowance by switching from
 * one to the other. Typing is the exception and does not reach here -- the
 * throttle collapses a keystroke stream into at most one frame every three
 * seconds, so typing never eats the budget for actually talking.
 */
async function allow(context: FrameContext): Promise<boolean> {
  const budget = await takeMessageSlot(context.commands, context.userId);

  if (!budget.allowed) {
    send(context.ws, {
      code: "rate_limited",
      message: "Too many actions",
      op: "error",
      retryAfterMs: budget.retryAfterMs,
    });
    return false;
  }

  return true;
}

/**
 * Announces a presence change to everyone entitled to see it.
 *
 * Two destinations, for two different reasons. `events:user:{id}` reaches the
 * user's OWN other devices, so a status set on the phone shows on the desktop.
 * Each `events:guild:{id}` reaches the people who render them in a member list.
 *
 * The guild ids come from the socket's state rather than a query, because this
 * runs on connect, on disconnect and on every explicit status change -- and
 * re-reading `guild_members` on each of those would put a query on the
 * disconnect path, which is the one path that also runs thousands of times at
 * once when a node dies.
 *
 * Someone in fifty guilds costs fifty publishes per transition. That is
 * acceptable precisely because it is a transition: only the first socket to
 * connect and the last to leave get here, not every tab.
 */
export async function publishPresence(
  context: Pick<FrameContext, "commands" | "guildIds" | "nodeId" | "userId">,
  presence: {
    clientType: "desktop" | "mobile" | "web";
    customStatus: string | null;
    lastActive: number;
    state: "dnd" | "idle" | "offline" | "online";
  }
): Promise<void> {
  const event = {
    origin: context.nodeId,
    presence,
    ts: presence.lastActive,
    type: "presence.updated",
  } as const;

  await Promise.all([
    publishEvent(context.commands, "user", context.userId, event),
    ...context.guildIds.map((guildId) =>
      publishEvent(context.commands, "guild", guildId, {
        memberId: context.userId,
        origin: context.nodeId,
        presence,
        ts: presence.lastActive,
        type: "member.presence",
      })
    ),
  ]);
}

export async function handlePing(context: FrameContext): Promise<void> {
  // Refreshing on the client's own beat as well as the server timer: the timer
  // can be throttled by the runtime under load, and this is the cheapest
  // possible confirmation that the socket is really live.
  await touchPresence(context.commands, {
    socketId: context.state.socket.id,
    userId: context.userId,
  });
  send(context.ws, { op: "pong" });
}

export async function handlePresenceUpdate(
  context: FrameContext,
  frame: Extract<ClientFrame, { op: "presence.update" }>
): Promise<void> {
  if (!(await allow(context))) {
    return;
  }

  await touchPresence(
    context.commands,
    { socketId: context.state.socket.id, userId: context.userId },
    { customStatus: frame.customStatus, state: frame.state }
  );

  await publishPresence(context, {
    clientType: "web",
    customStatus: frame.customStatus ?? null,
    lastActive: context.now,
    state: frame.state,
  });
}

export async function handleSubscribe(
  context: FrameContext,
  frame: Extract<ClientFrame, { op: "subscribe" }>
): Promise<void> {
  // The check that matters. The client picks the id, so without it any
  // authenticated user could join any guild's event stream.
  if (!(await canAccess(context.userId, frame.scope, frame.id))) {
    deny(context.ws, `Not a member of ${frame.scope} ${frame.id}`);
    return;
  }

  await context.registry.join(context.state.socket, frame.scope, frame.id);
  send(context.ws, { id: frame.id, op: "subscribed", scope: frame.scope });
}

export async function handleUnsubscribe(
  context: FrameContext,
  frame: Extract<ClientFrame, { op: "unsubscribe" }>
): Promise<void> {
  // No authorisation check: leaving something you should not have been in is
  // always allowed, and a client that was never joined is a no-op.
  await context.registry.leave(context.state.socket, frame.scope, frame.id);
}

export async function handleTypingStart(
  context: FrameContext,
  frame: Extract<ClientFrame, { op: "typing.start" }>
): Promise<void> {
  if (!(await canAccess(context.userId, "channel", frame.channelId))) {
    deny(context.ws, "No access to that channel");
    return;
  }

  const last = context.state.typingAt.get(frame.channelId) ?? 0;
  if (context.now - last < TYPING_THROTTLE_MS) {
    // Dropped silently. The indicator is already alive in Redis for another
    // five seconds, and the client re-sends on every keystroke.
    return;
  }
  context.state.typingAt.set(frame.channelId, context.now);

  await startTyping(context.commands, frame.channelId, context.userId);
  await publishEvent(context.commands, "channel", frame.channelId, {
    origin: context.nodeId,
    ts: context.now,
    type: "typing.started",
    userId: context.userId,
  });

  send(context.ws, {
    channelId: frame.channelId,
    op: "typing",
    users: await getTyping(context.commands, frame.channelId),
  });
}

export async function handleTypingStop(
  context: FrameContext,
  frame: Extract<ClientFrame, { op: "typing.stop" }>
): Promise<void> {
  context.state.typingAt.delete(frame.channelId);
  await stopTyping(context.commands, frame.channelId, context.userId);
}

export async function handleVoiceJoin(
  context: FrameContext,
  frame: Extract<ClientFrame, { op: "voice.join" }>
): Promise<void> {
  if (!(await canAccess(context.userId, "channel", frame.channelId))) {
    deny(context.ws, "No access to that channel");
    return;
  }
  if (!(await allow(context))) {
    return;
  }

  await joinVoice(context.commands, frame.channelId, context.userId, {
    peerId: frame.peerId,
    selfDeaf: frame.selfDeaf ?? false,
    selfMute: frame.selfMute ?? false,
    serverDeaf: false,
    serverMute: false,
  });

  await broadcastVoice(context, frame.channelId);
  send(context.ws, {
    channelId: frame.channelId,
    members: await getVoiceMembers(context.commands, frame.channelId),
    op: "voice.roster",
  });
}

export async function handleVoiceUpdate(
  context: FrameContext,
  frame: Extract<ClientFrame, { op: "voice.update" }>
): Promise<void> {
  if (!(await allow(context))) {
    return;
  }

  const updated = await updateVoiceState(
    context.commands,
    frame.channelId,
    context.userId,
    { selfDeaf: frame.selfDeaf, selfMute: frame.selfMute }
  );

  // Null means the user was not in the channel. Publishing anyway would tell
  // everyone about a state change that did not happen.
  if (updated) {
    await broadcastVoice(context, frame.channelId);
  }
}

export async function handleVoiceLeave(
  context: FrameContext,
  frame: Extract<ClientFrame, { op: "voice.leave" }>
): Promise<void> {
  await leaveVoice(context.commands, frame.channelId, context.userId);
  await broadcastVoice(context, frame.channelId);
}

/**
 * Tells the channel what this user's voice state now is.
 *
 * The roster is re-read rather than assembled from the frame, so the published
 * state is what Redis actually holds -- including a server mute a moderator set
 * that the client does not know about and must not be able to overwrite.
 */
async function broadcastVoice(
  context: FrameContext,
  channelId: string
): Promise<void> {
  const members = await getVoiceMembers(context.commands, channelId);
  const state = members.find((member) => member.userId === context.userId);

  await publishEvent(context.commands, "channel", channelId, {
    origin: context.nodeId,
    // Absent means they just left; the zeroed state is how subscribers know to
    // remove them from the roster.
    state: state ?? {
      joinedAt: context.now,
      peerId: "",
      selfDeaf: false,
      selfMute: false,
      serverDeaf: false,
      serverMute: false,
      userId: context.userId,
    },
    ts: context.now,
    type: "voice.state",
  });
}
