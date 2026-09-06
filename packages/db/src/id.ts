import { v7 as uuidv7 } from "uuid";

/**
 * UUIDv7 primary keys.
 *
 * v7 puts a 48-bit Unix millisecond timestamp in the high bits, so ids sort
 * chronologically. That matters for Postgres: v4 ids are uniformly random, so
 * every insert lands in a random leaf of the primary key's B-tree, scattering
 * writes and bloating the index. v7 ids append to the right-hand edge instead,
 * keeping inserts sequential -- while staying unguessable enough to expose in
 * URLs, unlike a serial.
 *
 * Stored in a native `uuid` column, not `text`: 16 bytes against 37, on every
 * primary key and every foreign key pointing at one, and compared as a 128-bit
 * value rather than through text collation.
 *
 * Every primary key carries this AND a database-side `DEFAULT uuidv7()`.
 * `$defaultFn` runs inside Drizzle, so the id exists before the round trip --
 * which is what lets a handler build a row and its children in one batch. But
 * it is invisible to anything not going through Drizzle: a raw SQL insert, a
 * psql session, another service. Those hit a NOT NULL violation, which is how
 * this gap was found. `uuidv7()` is a Postgres 18 builtin (this project runs
 * 18.6); on 17 or below, install pg_uuidv7 or drop the database-side default
 * and accept that Drizzle owns every insert.
 */
export function newId(): string {
  return uuidv7();
}
