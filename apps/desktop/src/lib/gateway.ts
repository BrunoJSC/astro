import type { ClientFrame, ServerFrame } from "@repo/server/gateway/model";
import { getSessionToken } from "./session-token";

/**
 * Client for the server's realtime gateway.
 *
 * The frame types come from `@repo/server/gateway/model` as types only, so the
 * contract is the server's own definition rather than a copy that drifts. The
 * import is erased at compile time -- nothing from Elysia reaches this bundle.
 */

export type GatewayStatus =
  | "closed"
  | "connecting"
  | "open"
  /** Terminal. The credential was rejected; reconnecting cannot help. */
  | "unauthorised";

export interface GatewayTopic {
  id: string;
  scope: "channel" | "guild";
}

export interface GatewayOptions {
  /** The API's http(s) origin. Converted to ws(s) here. */
  apiUrl: string;
  onFrame?: (frame: ServerFrame) => void;
  onStatus?: (status: GatewayStatus) => void;
}

export interface GatewayClient {
  close: () => void;
  connect: () => void;
  send: (frame: ClientFrame) => void;
  readonly status: GatewayStatus;
  /** Joins a topic, now if connected and again after every reconnect. */
  subscribe: (topic: GatewayTopic) => void;
  unsubscribe: (topic: GatewayTopic) => void;
}

/** Matches the server's `UNAUTHORISED`. */
const UNAUTHORISED = 4001;

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

function gatewayUrl(apiUrl: string): string {
  const url = new URL("/gateway", apiUrl);
  // `ws` for `http`, `wss` for `https`. Assembling the string by hand instead
  // gets this wrong the first time the API moves behind TLS.
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function createGatewayClient(options: GatewayOptions): GatewayClient {
  const url = gatewayUrl(options.apiUrl);
  /** Topics the caller wants, kept so a reconnect restores them. */
  const wanted = new Map<string, GatewayTopic>();

  let socket: WebSocket | null = null;
  let status: GatewayStatus = "closed";
  let attempt = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  /** Set by `close()`, so a deliberate shutdown does not reconnect. */
  let stopped = false;

  function setStatus(next: GatewayStatus): void {
    if (status !== next) {
      status = next;
      options.onStatus?.(next);
    }
  }

  function stopHeartbeat(): void {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  }

  function send(frame: ClientFrame): void {
    // Silently dropped while closed. The alternative is a queue, and a queue of
    // realtime frames flushed on reconnect delivers a burst of intentions from
    // minutes ago -- typing indicators for a message already sent.
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  }

  function scheduleReconnect(): void {
    if (stopped || status === "unauthorised") {
      return;
    }

    /*
     * Exponential backoff with full jitter.
     *
     * The jitter is not politeness. When a server node dies, every client it
     * held reconnects at once; a fixed delay makes them arrive together,
     * knock over whichever node they land on, and repeat. Spreading them
     * across the window is what breaks that cycle.
     */
    const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
    const delay = Math.random() * ceiling;
    attempt += 1;

    retry = setTimeout(connect, delay);
  }

  async function connect(): Promise<void> {
    if (stopped || socket) {
      return;
    }

    setStatus("connecting");

    /*
     * The token travels as a WebSocket subprotocol, because the browser API
     * cannot set an Authorization header and a query string would put the
     * session token into every proxy and access log it passes through.
     *
     * With no token the socket is opened plain, which is the browser case --
     * the cookie rides along on the upgrade by itself.
     */
    const token = await getSessionToken();

    if (stopped) {
      return;
    }

    const next = token
      ? new WebSocket(url, ["bearer", token])
      : new WebSocket(url);
    socket = next;

    next.onopen = () => {
      attempt = 0;
      setStatus("open");
      for (const topic of wanted.values()) {
        send({ id: topic.id, op: "subscribe", scope: topic.scope });
      }
    };

    next.onmessage = (message) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(message.data as string) as ServerFrame;
      } catch {
        // A frame this client cannot parse is the server's problem, not a
        // reason to tear down a working connection.
        return;
      }

      if (frame.op === "ready") {
        stopHeartbeat();
        // The server states its own interval, so changing it there does not
        // require shipping a new client.
        heartbeat = setInterval(
          () => send({ op: "ping" }),
          frame.heartbeatIntervalMs
        );
      }

      options.onFrame?.(frame);
    };

    next.onclose = (closeEvent) => {
      socket = null;
      stopHeartbeat();

      if (closeEvent.code === UNAUTHORISED) {
        // Retrying with the same rejected credential just burns connections.
        // The app has to sign in again before this client is useful.
        setStatus("unauthorised");
        return;
      }

      setStatus("closed");
      scheduleReconnect();
    };

    next.onerror = () => {
      // `onclose` always follows, and it is where reconnection is decided.
      // Handling both would schedule two reconnects for one failure.
    };
  }

  return {
    close() {
      stopped = true;
      stopHeartbeat();
      if (retry !== undefined) {
        clearTimeout(retry);
      }
      socket?.close();
      socket = null;
      setStatus("closed");
    },
    connect() {
      stopped = false;
      // `connect` reads the token, which can reject if storage is unreadable.
      // Swallowing it here leaves the client `closed` rather than crashing the
      // caller with an unhandled rejection from a fire-and-forget call.
      connect().catch(() => setStatus("closed"));
    },
    send,
    get status() {
      return status;
    },
    subscribe(topic) {
      wanted.set(`${topic.scope}:${topic.id}`, topic);
      send({ id: topic.id, op: "subscribe", scope: topic.scope });
    },
    unsubscribe(topic) {
      wanted.delete(`${topic.scope}:${topic.id}`);
      send({ id: topic.id, op: "unsubscribe", scope: topic.scope });
    },
  };
}
