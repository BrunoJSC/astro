import { v7 as uuidv7 } from "uuid";

/**
 * UUIDv7 primary keys.
 *
 * v7 puts a 48-bit Unix millisecond timestamp in the high bits, so ids sort
 * chronologically as plain strings. That matters for Postgres: v4 ids are
 * uniformly random, so every insert lands in a random leaf of the primary
 * key's B-tree, scattering writes and bloating the index. v7 ids append to the
 * right-hand edge instead, keeping inserts sequential -- while staying
 * unguessable enough to expose in URLs, unlike a serial.
 *
 * Generated in the application rather than by the database so a row's id is
 * known before the INSERT round-trips, which is what lets you build related
 * rows in one batch.
 *
 * `crypto.randomUUID()` is v4-only in both Node and Bun (Node silently ignores
 * a `{ version: 7 }` option), and `Bun.randomUUIDv7()` does not exist under
 * Node -- so this goes through the `uuid` package, which works on both.
 */
export function newId(): string {
  return uuidv7();
}
