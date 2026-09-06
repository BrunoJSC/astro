import { EventEmitter } from "node:events";
import type { KvClient } from "@repo/kv";
import type { Redis } from "ioredis";
import { GatewayRegistry } from "../../src/modules/gateway/registry";

/**
 * A real server, a real WebSocket, fake infrastructure behind them.
 *
 * These tests exist to cover the one layer no unit test reaches: the upgrade
 * itself. Whether Elysia's `.ws()` really runs the plugin lifecycle, whether
 * `authPlugin`'s derive really lands on `ws.data`, whether the TypeBox `body`
 * schema really rejects a malformed frame before a handler sees it, and what
 * close code the client really observes. All of that was read out of the Bun
 * adapter's source and reasoned about; none of it was ever executed.
 *
 * Redis and Postgres are faked, deliberately. Faking them keeps this file
 * about the transport, and the pieces they stand in for are covered elsewhere:
 * the Lua by `packages/kv/scripts/validate.ts` against a live server, the
 * registry by `tests/unit/gateway-registry.test.ts`, and cross-node fan-out by
 * `gateway-fanout.test.ts`, which needs two processes and a real Redis.
 *
 * `bun test`, not vitest: vitest runs under Node here -- verified -- and
 * `app.listen()` needs `Bun.serve`.
 */

/** Everything the gateway's open/message/close paths ask of a KvClient. */
export function fakeCommands(): {
  calls: { args: unknown[]; name: string }[];
  client: KvClient;
  sockets: Set<string>;
} {
  const calls: { args: unknown[]; name: string }[] = [];
  const sockets = new Set<string>();

  const record =
    (name: string, reply: (args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls.push({ args, name });
      return Promise.resolve(reply(args));
    };

  const client = {
    getTyping: record("getTyping", () => []),
    hgetall: record("hgetall", () => ({})),
    hset: record("hset", () => 1),
    presenceDrop: record("presenceDrop", (args) => {
      sockets.delete(String(args[3]));
      return sockets.size;
    }),
    presenceReap: record("presenceReap", () => [0, sockets.size]),
    presenceTouch: record("presenceTouch", (args) => {
      sockets.add(String(args[3]));
      return sockets.size;
    }),
    publish: record("publish", () => 1),
    ratelimitTake: record("ratelimitTake", () => [1, 4, 0]),
    scard: record("scard", () => sockets.size),
    typingList: record("typingList", () => []),
    typingStart: record("typingStart", () => 1),
    typingStop: record("typingStop", () => 1),
    voiceJoin: record("voiceJoin", () => 1),
    voiceLeave: record("voiceLeave", () => 0),
  } as unknown as KvClient;

  return { calls, client, sockets };
}

/** A subscriber the registry can drive without a server. */
export function fakeSubscriber(): Redis {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  return Object.assign(emitter, {
    subscribe: () => Promise.resolve(1),
    unsubscribe: () => Promise.resolve(1),
  }) as unknown as Redis;
}

export function fakeRealtime(nodeId = "node-test") {
  const { calls, client, sockets } = fakeCommands();
  const subscriber = fakeSubscriber();

  return {
    calls,
    realtime: {
      commands: client,
      nodeId,
      registry: new GatewayRegistry(subscriber, { origin: nodeId }),
      subscriber,
    },
    sockets,
  };
}

/**
 * Polls until a condition holds, or gives up.
 *
 * Closing a WebSocket resolves on the client the moment the socket is gone;
 * the server's `close` handler runs afterwards, asynchronously. A test that
 * asserts on that handler's effects immediately is racing it, and a test that
 * sleeps a fixed amount is slow when it passes and flaky when it does not.
 */
export async function waitFor(
  condition: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for a condition");
    }
    await Bun.sleep(10);
  }
}

export interface Frame {
  op: string;
  [key: string]: unknown;
}

/**
 * A WebSocket client that queues frames, so a test can await the next one
 * rather than racing a callback.
 *
 * `next()` resolves with whatever arrives, or rejects on timeout -- a test that
 * hangs waiting for a frame the server never sends is a test that tells you
 * nothing.
 */
export class TestClient {
  private readonly queue: Frame[] = [];
  private readonly waiting: ((frame: Frame) => void)[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private readonly socket: WebSocket;

  constructor(url: string, protocols?: string[]) {
    this.socket = protocols
      ? new WebSocket(url, protocols)
      : new WebSocket(url);

    this.socket.onmessage = (event) => {
      const frame = JSON.parse(event.data as string) as Frame;
      const waiter = this.waiting.shift();
      if (waiter) {
        waiter(frame);
      } else {
        this.queue.push(frame);
      }
    };

    this.closed = new Promise((resolve) => {
      this.socket.onclose = (event) =>
        resolve({ code: event.code, reason: event.reason });
    });
  }

  get protocol(): string {
    return this.socket.protocol;
  }

  open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.socket.onopen = () => resolve();
      this.socket.onerror = () => reject(new Error("socket failed to open"));
    });
  }

  next(timeoutMs = 2000): Promise<Frame> {
    const queued = this.queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for a frame")),
        timeoutMs
      );
      this.waiting.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** Bypasses JSON, for the schema-rejection cases. */
  sendRaw(payload: string): void {
    this.socket.send(payload);
  }

  close(): void {
    this.socket.close();
  }
}
