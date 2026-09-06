import { neonConfig } from "@neondatabase/serverless";

/**
 * Driver configuration, applied once at import time.
 *
 * Note on `fetchConnectionCache`: it is DEPRECATED and ignored as of
 * @neondatabase/serverless v1. Its own type declaration says "All queries now
 * use the connection pool/cache: this setting is ignored." Setting it would be
 * dead code that reads like an optimization. The live equivalent is
 * `poolQueryViaFetch` below.
 */

/**
 * Routes single, non-transactional Pool queries over HTTP instead of opening a
 * WebSocket. That is the cold-start win: one round trip rather than a socket
 * handshake, for the overwhelming majority of queries. Transactions and
 * multi-statement sessions still take the WebSocket path automatically.
 */
neonConfig.poolQueryViaFetch = true;

/**
 * Local development against a plain Postgres.
 *
 * Neon's WebSocket driver expects Neon's endpoint. Pointed at localhost it
 * would hang on a TLS handshake no local server answers, so these three
 * settings switch it to the plaintext proxy protocol the `neon-proxy`
 * container speaks. Applied only for local hosts -- production must keep TLS.
 *
 * Without a proxy running, use a Neon branch for local work instead; the
 * `@repo/db/edge` client needs one either way.
 */
/**
 * Where the proxy listens. Overridable because a test harness runs its own on
 * an ephemeral port, and because `docker compose` may publish it elsewhere.
 */
const PROXY_HOST = process.env.NEON_PROXY_HOST ?? "localhost";
const PROXY_PORT = process.env.NEON_PROXY_PORT ?? "5433";

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "db",
  "postgres",
]);

export function configureForHost(connectionString: string): void {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return;
  }

  if (!LOCAL_HOSTS.has(host)) {
    return;
  }

  /*
   * The callback receives the DATABASE host and port, not the proxy's, and has
   * to return the full proxy address including where to route to. Returning
   * just `${host}:5433/v1` -- as this did -- gives the proxy no `address` to
   * dial, and it answers the upgrade with a 400 instead of a 101. Found by
   * running it.
   */
  neonConfig.wsProxy = (dbHost, dbPort) =>
    `${PROXY_HOST}:${PROXY_PORT}/v1?address=${dbHost}:${dbPort}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.pipelineTLS = false;
  neonConfig.pipelineConnect = false;
}
