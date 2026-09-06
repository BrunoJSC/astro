import { Redis, type RedisOptions } from "ioredis";
import {
  PRESENCE_DROP,
  PRESENCE_REAP,
  PRESENCE_TOUCH,
  RATELIMIT_TAKE,
  TYPING_LIST,
  TYPING_START,
  TYPING_STOP,
  VOICE_JOIN,
  VOICE_LEAVE,
} from "./scripts";

/**
 * The Lua scripts, as methods.
 *
 * `defineCommand` attaches these at runtime, so TypeScript has to be told they
 * exist. Declaring them here rather than casting at each call site means a
 * change to a script's arity is a type error in one place.
 *
 * ioredis ships them with EVALSHA and falls back to EVAL on NOSCRIPT, so the
 * body crosses the wire once per server rather than once per call.
 */
export interface KvScripts {
  presenceDrop: (
    statusKey: string,
    socketsKey: string,
    livenessKey: string,
    socketId: string
  ) => Promise<number>;
  presenceReap: (
    socketsKey: string,
    livenessPrefix: string
  ) => Promise<[number, number]>;
  presenceTouch: (
    statusKey: string,
    socketsKey: string,
    livenessKey: string,
    ...args: (string | number)[]
  ) => Promise<number>;
  ratelimitTake: (
    key: string,
    now: number,
    windowMs: number,
    limit: number,
    token: string
  ) => Promise<[number, number, number]>;
  typingList: (indexKey: string, now: number) => Promise<string[]>;
  typingStart: (
    typingKey: string,
    indexKey: string,
    userId: string,
    now: number,
    ttlMs: number
  ) => Promise<number>;
  typingStop: (
    typingKey: string,
    indexKey: string,
    userId: string
  ) => Promise<number>;
  voiceJoin: (
    membersKey: string,
    userId: string,
    state: string
  ) => Promise<number>;
  voiceLeave: (membersKey: string, userId: string) => Promise<number>;
}

export type KvClient = Redis & KvScripts;

export interface KvConfig {
  options?: RedisOptions;
  /** `redis://` or `rediss://`. Valkey speaks the same protocol. */
  url: string;
}

function register(client: Redis): KvClient {
  client.defineCommand("presenceTouch", {
    lua: PRESENCE_TOUCH,
    numberOfKeys: 3,
  });
  client.defineCommand("presenceDrop", { lua: PRESENCE_DROP, numberOfKeys: 3 });
  client.defineCommand("presenceReap", { lua: PRESENCE_REAP, numberOfKeys: 1 });
  client.defineCommand("ratelimitTake", {
    lua: RATELIMIT_TAKE,
    numberOfKeys: 1,
  });
  client.defineCommand("typingStart", { lua: TYPING_START, numberOfKeys: 2 });
  client.defineCommand("typingStop", { lua: TYPING_STOP, numberOfKeys: 2 });
  client.defineCommand("typingList", { lua: TYPING_LIST, numberOfKeys: 1 });
  client.defineCommand("voiceJoin", { lua: VOICE_JOIN, numberOfKeys: 1 });
  client.defineCommand("voiceLeave", { lua: VOICE_LEAVE, numberOfKeys: 1 });
  return client as KvClient;
}

export function createKvClient(config: KvConfig): KvClient {
  return register(
    new Redis(config.url, {
      /*
       * Commands issued while disconnected are rejected instead of queued.
       *
       * The default queues them and flushes on reconnect, which for presence
       * means a burst of heartbeats from minutes ago arriving at once and
       * re-marking users online who have since gone. For real-time state,
       * failing now is more truthful than succeeding late.
       */
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => Math.min(times * 200, 3000),
      ...config.options,
    })
  );
}

/**
 * A dedicated connection for SUBSCRIBE.
 *
 * Under RESP2 this is a hard requirement: a subscribed connection accepts only
 * subscribe, unsubscribe and ping, and ioredis rejects anything else with
 * "Connection in subscriber mode". Under RESP3 -- which ioredis negotiates by
 * DEFAULT against a Redis 6+ server -- the restriction is gone and ordinary
 * commands work on a subscribed connection. Measured, both ways, in
 * `tests/integration/events.test.ts`.
 *
 * The split stays regardless, for two reasons that outlive the protocol:
 *
 *   1. `enableOfflineQueue` has to differ. Commands fail fast (`false`) so a
 *      stale heartbeat is refused rather than replayed minutes late; a
 *      subscriber queues (`true`) so a reconnect resumes rather than dropping
 *      the fan-out. One connection cannot be both.
 *   2. Fan-out and commands would share one socket and one reply pipeline. A
 *      busy guild's event stream would sit in front of the presence write
 *      behind it.
 *
 * PUBLISH is unaffected either way -- it does not put a connection into
 * subscriber mode, so the publisher keeps using the command connection.
 */
export function createKvSubscriber(client: KvClient): Redis {
  return client.duplicate({ enableOfflineQueue: true, lazyConnect: true });
}

let commands: KvClient | undefined;
let subscriber: Redis | undefined;

export interface KvConnections {
  commands: KvClient;
  subscriber: Redis;
}

/**
 * Process-wide pair, connected on first use.
 *
 * Lazy on purpose: importing the barrel must not open sockets, or every test
 * and build step that touches it tries to reach a server.
 */
export async function getKvConnections(
  config: KvConfig
): Promise<KvConnections> {
  if (!commands) {
    commands = createKvClient(config);
    await commands.connect();
  }
  if (!subscriber) {
    subscriber = createKvSubscriber(commands);
    await subscriber.connect();
  }
  return { commands, subscriber };
}

/** For graceful shutdown. `quit` drains in flight work; `disconnect` does not. */
export async function closeKvConnections(): Promise<void> {
  await Promise.allSettled([subscriber?.quit(), commands?.quit()]);
  subscriber = undefined;
  commands = undefined;
}
