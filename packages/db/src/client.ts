import { Pool } from "@neondatabase/serverless";
import { env } from "@repo/env/server";
import { drizzle } from "drizzle-orm/neon-serverless";
import { configureForHost } from "./neon-config";
import * as schema from "./schema";

configureForHost(env.DATABASE_URL);

/**
 * Default client: Neon's WebSocket driver.
 *
 * Chosen over `neon-http` for the general case because it is the only one that
 * supports interactive transactions -- `db.transaction()` needs a session that
 * spans statements, which a stateless HTTP request cannot provide. With
 * `poolQueryViaFetch` enabled (see ./neon-config), single queries still travel
 * over HTTP, so the socket is only paid for when a transaction actually needs
 * it. For edge runtimes, which cannot hold a socket at all, use `@repo/db/edge`.
 *
 * DATABASE_URL points at the POOLED endpoint: PgBouncer absorbs the connection
 * churn that serverless invocations produce, which a bare Postgres backend
 * cannot. Migrations go through DIRECT_URL instead -- see drizzle.config.ts.
 */
const pool = new Pool({ connectionString: env.DATABASE_URL });

export const db = drizzle(pool, { casing: "snake_case", schema });

export type Database = typeof db;

/**
 * Exported for graceful shutdown only -- a long-lived server should drain the
 * pool on SIGTERM. Do not reach for it to run queries; that bypasses the typed
 * client and the schema.
 */
export { pool };
