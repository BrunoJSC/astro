import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "../../src/schema";
import { startWsProxy, type WsProxy } from "./wsproxy";

/**
 * Shared setup for the tests that need a real Postgres.
 *
 * The existing `client.test.ts` checks that the clients CONSTRUCT -- that
 * `edge` throws on `transaction()`, that the driver flags are set. No SQL has
 * ever been executed against a database from this package's suite. These do
 * that: apply the migration, then exercise the schema through the same driver
 * and adapter production uses.
 *
 * **Postgres 18 or newer.** The schema's primary keys carry
 * `DEFAULT uuidv7()`, which is an 18 builtin. On 17 the migration fails at the
 * first table, which is the correct outcome and a confusing one to debug, so
 * the version is checked up front.
 *
 * SKIPS when nothing answers.
 *
 * `bun test`, not vitest: the tunnel uses `Bun.serve`, and vitest runs under
 * Node here. `tests/integration/` stays vitest and stays about client
 * construction, which needs no database at all.
 */

const HOST = process.env.PGHOST ?? "127.0.0.1";
const PORT = Number(process.env.PGPORT ?? 5434);
const USER = process.env.PGUSER ?? "postgres";
const DATABASE = process.env.PGDATABASE ?? "astro";

export const MIN_SERVER_VERSION = 18;

/** A plain TCP probe: milliseconds, rather than a driver's connect timeout. */
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
      `  Needs Postgres ${MIN_SERVER_VERSION}+ (the schema defaults to uuidv7()).\n\n`
  );
}

export interface TestDatabase {
  close: () => Promise<void>;
  db: ReturnType<typeof drizzle<typeof schema>>;
  pool: Pool;
}

let proxy: WsProxy | undefined;

/**
 * Connects through the production driver, over a local tunnel.
 *
 * `configureForHost` in `src/neon-config.ts` switches the driver to the
 * plaintext proxy protocol for a local host -- a branch that until now was
 * asserted about and never run. This points `wsProxy` at the tunnel rather
 * than at the hardcoded 5433, because the tunnel takes an ephemeral port.
 */
export async function connectDb(): Promise<TestDatabase> {
  proxy ??= await startWsProxy();

  // Same shape `configureForHost` produces: the callback is handed the
  // database's host and port and returns the proxy plus a routing address.
  neonConfig.wsProxy = (dbHost, dbPort) =>
    `127.0.0.1:${proxy?.port}/v1?address=${dbHost}:${dbPort}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
  // `configureForHost` turns `poolQueryViaFetch` off for local hosts now, but
  // this helper sets `wsProxy` itself rather than going through it, so the
  // same has to happen here.
  neonConfig.poolQueryViaFetch = false;

  const pool = new Pool({
    connectionString: `postgres://${USER}@${HOST}:${PORT}/${DATABASE}`,
  });

  return {
    close: async () => {
      await pool.end();
    },
    db: drizzle(pool, { casing: "snake_case", schema }),
    pool,
  };
}

/** Releases the shared tunnel. Call once, after the last suite. */
export function stopProxy(): void {
  proxy?.stop();
  proxy = undefined;
}

/**
 * Applies `drizzle/*.sql`, splitting on drizzle-kit's own separator.
 *
 * Not `drizzle-kit migrate`: that needs a config file, a connection of its
 * own, and writes a journal table. Reading the SQL keeps the test in charge of
 * what ran, and asserts the migration file itself rather than the tool.
 */
export async function applyMigrations(pool: Pool): Promise<string[]> {
  const file = join(import.meta.dir, "../../drizzle/0000_init.sql");
  const statements = readFileSync(file, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  for (const statement of statements) {
    await pool.query(statement);
  }

  return statements;
}

/** Drops everything, so a rerun starts from the migration rather than a mess. */
export async function resetSchema(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

export async function serverMajorVersion(pool: Pool): Promise<number> {
  const result = await pool.query<{ v: string }>(
    "SELECT current_setting('server_version_num') AS v"
  );
  return Math.floor(Number(result.rows[0]?.v ?? 0) / 10_000);
}
