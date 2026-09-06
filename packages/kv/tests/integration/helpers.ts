import { connect } from "node:net";
import { createKvClient, type KvClient } from "../../src/client";

/**
 * Shared setup for the tests that need a real Redis.
 *
 * The unit tests use a fake client and deliberately do not reimplement the Lua
 * scripts -- a test of a reimplementation tests the reimplementation. These are
 * the other half: the scripts run on the server, and every atomicity claim in
 * this package lives inside them.
 *
 * Everything here SKIPS when no server answers, which is the normal outcome on
 * a machine without Docker. `bun run kv:up` first, or point REDIS_URL at one.
 */

/** `redis://` is not a scheme `URL` parses a host out of; swap it for one. */
const REDIS_SCHEME = /^rediss?/;

/**
 * Database 15, not 0.
 *
 * Tests call FLUSHDB, and a developer who ran `kv:up` and then pointed the dev
 * server at the same instance would otherwise lose their session and presence
 * mid-run. 15 is conventionally scratch.
 */
const TEST_DB = 15;

const BASE = process.env.REDIS_URL ?? "redis://localhost:6379";

export const REDIS_URL = `${BASE.replace(/\/\d+$/, "")}/${TEST_DB}`;

/**
 * A plain TCP probe, not an ioredis connection.
 *
 * Asking ioredis costs seconds even with retries disabled: `connect()` waits
 * out its timeout, and on macOS `localhost` resolves to both ::1 and
 * 127.0.0.1, so the attempt happens twice. This is a yes/no question about a
 * listening port, and a socket answers it in milliseconds.
 */
export function reachable(url = BASE): Promise<boolean> {
  const { hostname, port } = new URL(url.replace(REDIS_SCHEME, "http"));

  return new Promise((resolve) => {
    const socket = connect({
      host: hostname || "127.0.0.1",
      port: Number(port) || 6379,
    });

    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function announceSkip(what: string, url = BASE): void {
  process.stderr.write(
    `\n[${what}] skipped: no Redis at ${url}.\n` +
      "  cd packages/kv && bun run kv:up\n\n"
  );
}

/** A connected client on the scratch database. */
export async function connectKv(): Promise<KvClient> {
  const client = createKvClient({ url: REDIS_URL });
  await client.connect();
  return client;
}

/**
 * Fresh ids per test.
 *
 * Cheaper and safer than flushing between tests: the key builders take an id,
 * so a unique one is a private namespace. Tests can then run in any order, and
 * a leftover key from a failed run cannot make a later one pass.
 */
export const newId = (): string => crypto.randomUUID();

/** Milliseconds, for the TTL assertions. `Bun.sleep` resolves late, not early. */
export const sleep = (ms: number): Promise<void> => Bun.sleep(ms);
