import type { types } from "cassandra-driver";

/**
 * Bucket arithmetic.
 *
 * A bucket is the second half of the partition key: `'2026-09'`. Everything
 * here exists because that choice moves work from the database to the client --
 * the database can no longer answer "the last 50 messages" on its own, because
 * they may not all be in one partition.
 *
 * A trap worth knowing before writing anything that touches ids here: a
 * `timeuuid` does NOT sort correctly as a string. UUIDv1 lays the timestamp out
 * low-bits-first (time_low-time_mid-time_hi), so a March id can compare greater
 * than an April one. Scylla sorts the `timeuuid` TYPE by the embedded
 * timestamp, which is why `ORDER BY message_id DESC` is right in CQL -- but in
 * JavaScript, compare `getDate()` and never the strings. Bucket strings are the
 * opposite case: 'YYYY-MM' sorts lexicographically in chronological order,
 * which is why `bucketRange` can compare them directly.
 */

const BUCKET_PATTERN = /^\d{4}-\d{2}$/;

/** `'2026-09'` from a Date, in UTC. */
export function bucketFor(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * The bucket a message belongs to, derived from the id's own timestamp.
 *
 * Never from `new Date()`. A message written late -- a retry, a backfill, a
 * queue that fell behind over a month boundary -- would land in the current
 * bucket while its id sorts into the previous one, and every read of the
 * correct bucket would miss it silently.
 */
export function bucketForId(id: types.TimeUuid): string {
  return bucketFor(id.getDate());
}

/** The bucket immediately before this one, rolling the year at January. */
export function previousBucket(bucket: string): string {
  assertBucket(bucket);
  const [year, month] = bucket.split("-").map(Number) as [number, number];
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, "0")}`;
}

export function nextBucket(bucket: string): string {
  assertBucket(bucket);
  const [year, month] = bucket.split("-").map(Number) as [number, number];
  return month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/**
 * The sequence of buckets to read, newest first.
 *
 * `count` is a hard stop, and it is the answer to a real failure mode: a
 * channel with no messages for two years would otherwise walk backwards
 * forever, one query per empty month, and the read would never return. Bounding
 * the walk turns "no more history" into a definite answer.
 */
export function bucketsBackFrom(
  bucket: string,
  count: number
): readonly string[] {
  assertBucket(bucket);
  const out: string[] = [bucket];
  for (let i = 1; i < count; i += 1) {
    out.push(previousBucket(out[i - 1] as string));
  }
  return out;
}

/** Every bucket from `from` to `to` inclusive, oldest first. */
export function bucketRange(from: Date, to: Date): readonly string[] {
  const last = bucketFor(to);
  const out: string[] = [];
  let current = bucketFor(from);
  // Guard against a reversed range rather than looping to exhaustion.
  for (let i = 0; i < 1200 && current <= last; i += 1) {
    out.push(current);
    current = nextBucket(current);
  }
  return out;
}

function assertBucket(bucket: string): void {
  if (!BUCKET_PATTERN.test(bucket)) {
    throw new TypeError(`Not a bucket: "${bucket}". Expected YYYY-MM.`);
  }
}
