import { neon } from "@neondatabase/serverless";
import { env } from "@repo/env/server";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

/**
 * Edge client: Neon over plain HTTP fetch, no socket and no connection state.
 *
 * For runtimes that cannot hold a TCP or WebSocket connection -- Vercel Edge,
 * Cloudflare Workers, Next.js middleware. Each query is one HTTP round trip
 * against Neon's SQL-over-HTTP endpoint, which is also why cold starts here
 * cost nothing: there is no handshake to amortise.
 *
 * The trade-off is transactions. `db.transaction()` EXISTS on this client but
 * throws "No transactions support in neon-http driver" the moment it is
 * called -- a stateless request cannot hold a session open across statements.
 * Because it type-checks and only fails at runtime, it is worth knowing before
 * reaching for it.
 *
 * `db.batch([...])` is the atomic primitive that does work here: several
 * statements in one request, applied together. What it cannot do is branch --
 * read a row, decide, then write. That needs the round trips only a session
 * provides, so it belongs on `@repo/db`'s default client.
 *
 * The same limitation applies to migrations: drizzle-kit's neon-http migrator
 * cannot roll back a failed migration.
 *
 * No `configureForHost` call: this driver talks to Neon's HTTP endpoint and
 * has no local-Postgres mode at all.
 */
export const db = drizzle(neon(env.DATABASE_URL), {
  casing: "snake_case",
  schema,
});

export type EdgeDatabase = typeof db;
