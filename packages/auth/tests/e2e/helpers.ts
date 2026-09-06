import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { startWsProxy, type WsProxy } from "./wsproxy";

/**
 * Shared setup for the tests that sign users in against a real database.
 *
 * The existing `tests/integration/` suite covers argon2 for real and checks
 * that the handler is shaped correctly, but nothing there creates a user. An
 * auth package whose sign-up path has never run is not tested in the way that
 * matters.
 *
 * Getting there needs three things arranged before `@repo/auth/server` is
 * imported, because it builds its Better Auth instance at module scope:
 *
 *   1. `DATABASE_URL` pointing at a LOCAL host, so `configureForHost` in
 *      `@repo/db` switches the driver to the plaintext proxy protocol.
 *   2. `NEON_PROXY_HOST` / `NEON_PROXY_PORT` pointing at the tunnel, which
 *      takes an ephemeral port.
 *   3. The tunnel actually listening.
 *
 * Hence `loadAuth()` rather than a plain import: the environment has to exist
 * first. Every suite awaits it before touching `auth`.
 *
 * `bun test`, not vitest: the tunnel uses `Bun.serve`, and vitest runs under
 * Node here.
 */

const HOST = process.env.PGHOST ?? "127.0.0.1";
const PORT = Number(process.env.PGPORT ?? 5434);
const USER = process.env.PGUSER ?? "postgres";
/**
 * A database of its own, not the one `@repo/db` uses.
 *
 * That suite drops and recreates `public` to test the migration from scratch.
 * Sharing one database means whichever package turbo schedules second finds no
 * tables -- which showed up as `relation "user" does not exist` in a suite that
 * never touches DDL.
 */
const DATABASE = process.env.PGDATABASE ?? "astro_auth";
const ADMIN_DATABASE = "postgres";

export function reachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port: PORT });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(400);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function announceSkip(what: string): void {
  process.stderr.write(
    `\n[${what}] skipped: no Postgres at ${HOST}:${PORT}.\n` +
      "  Needs Postgres 18+ with @repo/db's migration applied.\n\n"
  );
}

export interface Loaded {
  auth: typeof import("../../src/server").auth;
  db: typeof import("@repo/db");
}

let proxy: WsProxy | undefined;
let loaded: Promise<Loaded> | undefined;

/**
 * Starts the tunnel, points the environment at it, then imports auth AND db.
 *
 * `@repo/db` comes back from here rather than being imported directly by a
 * test, and that is not tidiness: it validates `@repo/env/server` at module
 * scope, so a static import evaluates before this function has set
 * `DATABASE_URL` and fails with "Invalid environment variables".
 *
 * Cached, because Better Auth is a singleton and a second instance would open
 * its own pool.
 */
export function loadAuth(): Promise<Loaded> {
  loaded ??= (async () => {
    proxy = await startWsProxy();

    process.env.NEON_PROXY_HOST = "127.0.0.1";
    process.env.NEON_PROXY_PORT = String(proxy.port);
    process.env.DATABASE_URL = `postgres://${USER}@${HOST}:${PORT}/${DATABASE}`;
    process.env.BETTER_AUTH_SECRET ??=
      "test-secret-with-at-least-thirty-two-chars";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3001";

    // `configureForHost` runs when @repo/db is imported, which happens after
    // this; the admin connections below need the same settings now.
    const { neonConfig } = await import("@neondatabase/serverless");
    neonConfig.wsProxy = (dbHost, dbPort) =>
      `127.0.0.1:${proxy?.port}/v1?address=${dbHost}:${dbPort}`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.pipelineTLS = false;
    neonConfig.pipelineConnect = false;
    neonConfig.poolQueryViaFetch = false;

    await prepareDatabase();

    const [server, database] = await Promise.all([
      import("../../src/server"),
      import("@repo/db"),
    ]);

    return { auth: server.auth, db: database };
  })();

  return loaded;
}

/**
 * Creates the database if it is absent, then applies `@repo/db`'s migration.
 *
 * The migration is read from the `@repo/db` package rather than copied. Two
 * copies of a schema drift, and this suite's whole point is that Better Auth
 * writes into the tables that package actually defines.
 */
async function prepareDatabase(): Promise<void> {
  const { Pool } = await import("@neondatabase/serverless");
  const base = `postgres://${USER}@${HOST}:${PORT}`;

  const admin = new Pool({ connectionString: `${base}/${ADMIN_DATABASE}` });
  const existing = await admin.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [DATABASE]
  );
  if (existing.rows.length === 0) {
    // No parameters: CREATE DATABASE does not take them.
    await admin.query(`CREATE DATABASE "${DATABASE}"`);
  }
  await admin.end();

  const target = new Pool({ connectionString: `${base}/${DATABASE}` });
  await target.query("DROP SCHEMA IF EXISTS public CASCADE");
  await target.query("CREATE SCHEMA public");

  const migration = readFileSync(
    join(import.meta.dir, "../../../db/drizzle/0000_init.sql"),
    "utf8"
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) {
      await target.query(trimmed);
    }
  }
  await target.end();
}

export function stopProxy(): void {
  proxy?.stop();
  proxy = undefined;
}

/** Unique per call, so suites never collide on a unique constraint. */
export const newEmail = (): string => `${crypto.randomUUID()}@example.test`;

/** Lower-case letters only: the username validator rejects everything else. */
export const newUsername = (): string =>
  `u${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

export const PASSWORD = "correct-horse-battery-staple";

/** The `set-cookie` value, for the calls that need to look signed in. */
export function cookieFrom(headers: Headers): string {
  return (headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}
