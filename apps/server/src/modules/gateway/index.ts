import { auth } from "@repo/auth/server";
import {
  dropPresence,
  HEARTBEAT_INTERVAL_MS,
  type HeartbeatHandle,
  startHeartbeat,
  touchPresence,
  userSocketsKey,
} from "@repo/kv";
import { Elysia } from "elysia";
import { authPlugin } from "../../plugins/auth";
import { getRealtime, kvPlugin } from "../../plugins/kv";
import { guildIdsFor } from "./authorize";
import {
  type FrameContext,
  handlePing,
  handlePresenceUpdate,
  handleSubscribe,
  handleTypingStart,
  handleTypingStop,
  handleUnsubscribe,
  handleVoiceJoin,
  handleVoiceLeave,
  handleVoiceUpdate,
  publishPresence,
  type SocketState,
  send,
  UNAUTHORISED,
} from "./handlers";
import { clientFrame } from "./model";
import type { GatewaySocket } from "./registry";

/**
 * The realtime gateway.
 *
 * One WebSocket per client, carrying presence, typing, voice state and whatever
 * other nodes publish. It does NOT carry message history, which is read over
 * HTTP from ScyllaDB, and that split is deliberate: pub/sub is fire-and-forget,
 * so a node that was disconnected when an event was published never sees it.
 * Events are invalidation hints on top of a durable read, never the only copy.
 *
 * ## Why per-socket state lives in a module map
 *
 * Elysia registers `.ws()` as an ordinary route -- `app.route("WS", path, ...)`
 * -- so the whole lifecycle runs on the upgrade and `authPlugin`'s derive puts
 * the session on `ws.data`. But the Bun adapter then does `data: {...context}`
 * exactly ONCE, at upgrade. `ws.data` is a frozen snapshot: there is nowhere on
 * it to hang state that has to change while the socket is open, and nothing on
 * it is ever recomputed.
 *
 * So the heartbeat handle, the typing throttle and the user's guild ids live in
 * `states`, keyed by `ws.id`. The same snapshot is why the session has to be
 * revalidated explicitly -- see `startSessionWatch`.
 */

interface LiveSocket extends SocketState {
  heartbeat: HeartbeatHandle;
  /** Stops the session revalidation loop. */
  stopWatch: () => void;
}

const states = new Map<string, LiveSocket>();

/**
 * Rechecks the session for as long as the socket is open.
 *
 * `ws.data.user` is the session as it was at the upgrade and is never refreshed,
 * so without this a socket keeps streaming events after the user logs out,
 * changes their password, or has the session revoked from another device --
 * until they happen to disconnect, which may be days.
 *
 * On the heartbeat's own interval, so the exposure window is bounded by the
 * same number that bounds presence staleness.
 *
 * A failed lookup does NOT close the socket. Only an explicit "there is no
 * session" does. A blip in Postgres would otherwise disconnect every client on
 * the node at once, turning a database hiccup into a thundering reconnect.
 */
function startSessionWatch(cookie: string, onRevoked: () => void): () => void {
  const timer = setInterval(async () => {
    try {
      const result = await auth.api.getSession({
        headers: new Headers({ cookie }),
      });
      if (!result?.session) {
        onRevoked();
      }
    } catch (error) {
      process.stderr.write(`[gateway] session check: ${describe(error)}\n`);
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Without unref a server cannot exit while any client is connected: every
  // open socket would hold a pending timer.
  timer.unref?.();

  return () => clearInterval(timer);
}

export const gatewayModule = new Elysia({ name: "module.gateway" })
  .use(authPlugin)
  .use(kvPlugin)
  .ws("/gateway", {
    body: clientFrame,

    async close(ws) {
      const state = states.get(ws.id);
      states.delete(ws.id);

      if (!state) {
        return;
      }

      state.stopWatch();

      const { commands, nodeId, registry } = await getRealtime();

      await registry.remove(state.socket);
      // `stop` drops the socket as well, so a clean close does not wait out the
      // 60-second TTL before the user stops looking online.
      await state.heartbeat.stop();

      const remaining = await commands.scard(
        userSocketsKey(state.socket.userId)
      );

      /*
       * Only the LAST socket announces going offline. Closing one tab while
       * another device is connected is not a transition, and publishing it
       * would make the user vanish from every member list until their next
       * heartbeat put them back.
       */
      if (remaining === 0) {
        await publishPresence(
          {
            commands,
            guildIds: state.guildIds,
            nodeId,
            userId: state.socket.userId,
          },
          {
            clientType: "web",
            customStatus: null,
            lastActive: Date.now(),
            state: "offline",
          }
        );
      }
    },

    async message(ws, frame) {
      const { user } = ws.data;
      const state = states.get(ws.id);

      // A frame arriving before `open` finished, or after the session watch
      // closed the socket. Neither should reach a handler.
      if (!(user && state)) {
        ws.close(UNAUTHORISED, "unauthorised");
        return;
      }

      const { commands, nodeId, registry } = await getRealtime();
      const context: FrameContext = {
        commands,
        guildIds: state.guildIds,
        nodeId,
        now: Date.now(),
        registry,
        state,
        userId: user.id,
        ws,
      };

      switch (frame.op) {
        case "ping":
          await handlePing(context);
          break;
        case "presence.update":
          await handlePresenceUpdate(context, frame);
          break;
        case "subscribe":
          await handleSubscribe(context, frame);
          break;
        case "unsubscribe":
          await handleUnsubscribe(context, frame);
          break;
        case "typing.start":
          await handleTypingStart(context, frame);
          break;
        case "typing.stop":
          await handleTypingStop(context, frame);
          break;
        case "voice.join":
          await handleVoiceJoin(context, frame);
          break;
        case "voice.update":
          await handleVoiceUpdate(context, frame);
          break;
        case "voice.leave":
          await handleVoiceLeave(context, frame);
          break;
        default:
          // Unreachable: the schema rejects anything else before it gets here.
          break;
      }
    },

    async open(ws) {
      const { user } = ws.data;

      /*
       * The session comes from the upgrade request's cookies, which browsers
       * send but cannot be replaced with a header -- the WebSocket API has no
       * way to set one. Fine for `apps/web`; the desktop and native clients
       * have no cookie jar for `tauri://localhost` and will need a token in the
       * query string or a subprotocol. Not built yet.
       */
      if (!user) {
        send(ws, {
          code: "unauthorised",
          message: "No valid session",
          op: "error",
        });
        ws.close(UNAUTHORISED, "unauthorised");
        return;
      }

      const { commands, nodeId, registry } = await getRealtime();

      const socket: GatewaySocket = {
        id: ws.id,
        send: (payload) => ws.send(payload as never),
        userId: user.id,
      };

      await registry.add(socket);

      const sockets = await touchPresence(
        commands,
        { socketId: ws.id, userId: user.id },
        { clientType: "web", state: "online" }
      );

      // Read once per connection and kept, so the disconnect path -- the one
      // that also runs for every client at once when a node dies -- needs no
      // query of its own.
      const guildIds = await guildIdsFor(user.id);

      states.set(ws.id, {
        guildIds,
        heartbeat: startHeartbeat(commands, {
          onError: (error) => {
            process.stderr.write(`[gateway] heartbeat: ${describe(error)}\n`);
          },
          socketId: ws.id,
          userId: user.id,
        }),
        socket,
        stopWatch: startSessionWatch(
          ws.data.request.headers.get("cookie") ?? "",
          () => {
            send(ws, {
              code: "session_revoked",
              message: "Session is no longer valid",
              op: "error",
            });
            ws.close(UNAUTHORISED, "session_revoked");
          }
        ),
        typingAt: new Map(),
      });

      /*
       * Only the FIRST socket announces. A second device connecting is not a
       * transition -- announcing it again would light up "came online" for
       * everyone watching, every time the user opened a tab.
       */
      if (sockets === 1) {
        await publishPresence(
          { commands, guildIds, nodeId, userId: user.id },
          {
            clientType: "web",
            customStatus: null,
            lastActive: Date.now(),
            state: "online",
          }
        );
      }

      send(ws, {
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        op: "ready",
        socketId: ws.id,
        userId: user.id,
      });
    },
  });

/**
 * Drops every socket this node holds. For SIGTERM, before the process exits.
 *
 * Presence has a 60-second TTL, so a process that exits without this leaves all
 * of its users looking online for a full minute -- on every deploy, for every
 * client that node was holding.
 */
export async function shutdownGateway(): Promise<void> {
  const open = [...states.values()];
  states.clear();

  if (open.length === 0) {
    return;
  }

  const { commands } = await getRealtime();

  await Promise.allSettled(
    open.map(async (state) => {
      state.stopWatch();
      await state.heartbeat.stop();
      await dropPresence(commands, {
        socketId: state.socket.id,
        userId: state.socket.userId,
      });
    })
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
