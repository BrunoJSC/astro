import { readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { Client, types } from "cassandra-driver";

/**
 * Shared setup for the tests that need a real CQL server.
 *
 * The unit tests parse the CQL as text and check it against the wrappers.
 * These apply it to a server and run queries through it, which is the only way
 * to see the things CQL enforces rather than describes -- clustering order,
 * null rules on key columns, and what a partition actually returns.
 *
 * ScyllaDB is Linux-only, so this runs against whatever speaks CQL on 9042:
 * Scylla from `docker compose up`, or Apache Cassandra, which is the engine
 * Scylla maintains CQL compatibility with. Everything here is portable between
 * them; anything Scylla-specific (compaction behaviour, tuning) is not covered
 * and cannot be.
 *
 * SKIPS when nothing answers.
 */

const HOST = process.env.SCYLLA_HOST ?? "127.0.0.1";
const PORT = Number(process.env.SCYLLA_PORT ?? 9042);
const DATACENTER = process.env.SCYLLA_DATACENTER ?? "datacenter1";

export const KEYSPACE = "astro_chat";

const NUMBERED_CQL = /^\d+_.*\.cql$/;
const LINE_COMMENT = /--.*$/u;

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
    `\n[${what}] skipped: nothing speaking CQL at ${HOST}:${PORT}.\n` +
      "  cd packages/chat-db && docker compose up -d --wait\n\n"
  );
}

/** A client with no keyspace, for DDL and for the schema tables. */
export function rawClient(): Client {
  return new Client({
    contactPoints: [HOST],
    localDataCenter: DATACENTER,
  });
}

export function keyspaceClient(): Client {
  return new Client({
    contactPoints: [HOST],
    keyspace: KEYSPACE,
    localDataCenter: DATACENTER,
  });
}

/**
 * Applies `cql/` in filename order, as a deploy would.
 *
 * Statements are split on `;` after comments are stripped -- the driver takes
 * one statement per call, unlike `cqlsh -f`. Every file is `IF NOT EXISTS`, so
 * this is safe to run against a server that already has the schema, which is
 * what makes the suite runnable twice without a teardown.
 */
export async function applySchema(client: Client): Promise<string[]> {
  const dir = join(import.meta.dir, "../../cql");
  const files = readdirSync(dir)
    .filter((name) => NUMBERED_CQL.test(name))
    .sort();

  const applied: string[] = [];

  for (const file of files) {
    const body = readFileSync(join(dir, file), "utf8")
      .split("\n")
      .map((line) => line.replace(LINE_COMMENT, ""))
      .join("\n");

    for (const statement of body.split(";")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) {
        await client.execute(trimmed);
      }
    }
    applied.push(file);
  }

  return applied;
}

/**
 * Fresh ids per test.
 *
 * Cheaper than truncating between tests, and safer: every table is partitioned
 * by an id, so a unique one is a private partition. Tests can run in any order
 * and a row left by a failed run cannot make a later one pass.
 */
export const newUuid = (): types.Uuid => types.Uuid.random();

/** A timeuuid for a specific moment, for the bucket and ordering tests. */
export const timeuuidAt = (iso: string): types.TimeUuid =>
  types.TimeUuid.fromDate(new Date(iso));

export const newTimeuuid = (): types.TimeUuid => types.TimeUuid.now();
