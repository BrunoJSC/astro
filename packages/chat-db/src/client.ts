import { auth, Client, types } from "cassandra-driver";

/**
 * The Scylla session.
 *
 * One `Client` per process, held open. It maintains a connection pool per node,
 * a token-aware routing table and prepared-statement caches -- constructing one
 * per request would throw all three away and reconnect on every query.
 */
export interface ScyllaConfig {
  contactPoints: readonly string[];
  credentials?: { username: string; password: string };
  keyspace: string;
  /**
   * Required by the driver's default load-balancing policy, and worth
   * understanding: it is what makes the client prefer replicas in its own
   * datacentre. Getting it wrong means every query crosses a region.
   */
  localDataCenter: string;
}

let client: Client | undefined;

export function createScyllaClient(config: ScyllaConfig): Client {
  return new Client({
    authProvider: config.credentials
      ? new auth.PlainTextAuthProvider(
          config.credentials.username,
          config.credentials.password
        )
      : undefined,
    contactPoints: [...config.contactPoints],
    keyspace: config.keyspace,
    localDataCenter: config.localDataCenter,
    queryOptions: {
      /*
       * LOCAL_QUORUM, not ONE and not QUORUM.
       *
       * ONE can read a replica that has not yet received the write, so a
       * message can appear and then vanish on refresh. Plain QUORUM counts
       * replicas across every datacentre, which makes each query wait on a
       * cross-region round trip. LOCAL_QUORUM is a majority within this DC:
       * consistent for anyone reading nearby, and no WAN hop.
       */
      consistency: types.consistencies.localQuorum,
      fetchSize: 100,
      /*
       * Prepared by default. An unprepared statement is parsed on every
       * execution and, worse, cannot be routed by token -- the driver does not
       * know which partition it touches, so it picks a coordinator at random
       * and pays an extra hop.
       */
      prepare: true,
    },
    socketOptions: {
      connectTimeout: 5000,
      readTimeout: 12_000,
    },
  });
}

/**
 * Process-wide singleton, connected on first use.
 *
 * Deliberately lazy: importing this module must not open sockets, or every test
 * and every build step that touches the barrel would try to reach a database.
 */
export async function getScyllaClient(config: ScyllaConfig): Promise<Client> {
  if (!client) {
    client = createScyllaClient(config);
    await client.connect();
  }
  return client;
}

/** For graceful shutdown. A dropped process leaves connections to time out. */
export async function closeScyllaClient(): Promise<void> {
  await client?.shutdown();
  client = undefined;
}
