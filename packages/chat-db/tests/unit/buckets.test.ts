import { describe, expect, it } from "bun:test";
import { types } from "cassandra-driver";
import {
  bucketFor,
  bucketForId,
  bucketRange,
  bucketsBackFrom,
  nextBucket,
  previousBucket,
} from "../../src/buckets";

describe("bucketFor", () => {
  it("formats as YYYY-MM in UTC", () => {
    expect(bucketFor(new Date("2026-09-06T04:00:00Z"))).toBe("2026-09");
    expect(bucketFor(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });

  it("uses UTC, not the local zone", () => {
    // 23:30 on the 31st in UTC is already the next month west of Greenwich.
    // Reading local time here would file the row in the wrong partition.
    expect(bucketFor(new Date("2026-08-31T23:30:00Z"))).toBe("2026-08");
  });
});

describe("previousBucket / nextBucket", () => {
  it("rolls the year at the January boundary", () => {
    expect(previousBucket("2026-01")).toBe("2025-12");
    expect(nextBucket("2025-12")).toBe("2026-01");
  });

  it("pads single-digit months", () => {
    expect(previousBucket("2026-10")).toBe("2026-09");
    expect(nextBucket("2026-09")).toBe("2026-10");
  });

  it("rejects a malformed bucket instead of computing nonsense", () => {
    expect(() => previousBucket("2026-9")).toThrow();
    expect(() => previousBucket("september")).toThrow();
  });
});

describe("bucketsBackFrom", () => {
  it("walks backwards across the year boundary", () => {
    expect(bucketsBackFrom("2026-02", 4)).toEqual([
      "2026-02",
      "2026-01",
      "2025-12",
      "2025-11",
    ]);
  });

  it("is bounded", () => {
    /*
     * The bound is the point. A channel dormant for two years would otherwise
     * issue one query per empty month and never return an answer.
     */
    expect(bucketsBackFrom("2026-09", 6)).toHaveLength(6);
  });
});

describe("bucketRange", () => {
  it("sorts lexicographically in chronological order", () => {
    // The reason the bucket is text 'YYYY-MM' and not a number: string
    // comparison and time comparison agree, so range scans work.
    const range = bucketRange(
      new Date("2025-11-01T00:00:00Z"),
      new Date("2026-02-01T00:00:00Z")
    );
    expect(range).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect([...range].sort()).toEqual([...range]);
  });

  it("returns nothing for a reversed range rather than looping", () => {
    expect(
      bucketRange(new Date("2026-05-01Z"), new Date("2026-01-01Z"))
    ).toEqual([]);
  });
});

describe("bucketForId", () => {
  it("derives the bucket from the id's own timestamp", () => {
    /*
     * Not from `new Date()`. A message written late -- a retry, a backfill, a
     * queue that fell behind across a month boundary -- would land in the
     * current bucket while its id sorts into the previous one, and every read
     * of the correct partition would miss it silently.
     */
    const id = types.TimeUuid.fromDate(new Date("2026-03-15T10:00:00Z"));
    expect(bucketForId(id)).toBe("2026-03");
  });
});

describe("timeuuid ordering", () => {
  it("does NOT sort correctly as a string", () => {
    /*
     * Guard against a plausible optimisation that silently corrupts paging.
     *
     * UUIDv1 lays out the timestamp low-bits-first (time_low-time_mid-time_hi),
     * so lexicographic order is not chronological order. Scylla sorts the
     * `timeuuid` type by the embedded timestamp, so ORDER BY in CQL is correct
     * -- but comparing the strings in JavaScript is not. Compare `getDate()`,
     * or let the database do it.
     */
    const march = types.TimeUuid.fromDate(new Date("2026-03-15T10:00:00Z"));
    const april = types.TimeUuid.fromDate(new Date("2026-04-01T00:00:00Z"));

    expect(march.getDate() < april.getDate()).toBe(true);
    expect(march.toString() < april.toString()).toBe(false);
  });
});
