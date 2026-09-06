import { describe, expect, it } from "bun:test";
import { newId } from "../../src/id";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newId", () => {
  it("produces a well-formed UUIDv7", () => {
    const id = newId();
    expect(id).toMatch(UUID_PATTERN);
    // Version nibble is 7 and the variant is RFC 4122 (10xx).
    expect(id[14]).toBe("7");
    expect("89ab").toContain(id[19] ?? "");
  });

  it("is unique across a tight loop", () => {
    const ids = Array.from({ length: 10_000 }, () => newId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sorts chronologically as a plain string", async () => {
    const first = newId();
    // Cross the millisecond boundary the v7 timestamp is built from.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = newId();
    expect(first < second).toBe(true);
  });

  it("encodes the current time in the high 48 bits", () => {
    const before = Date.now();
    const id = newId();
    const timestamp = Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
    expect(timestamp).toBeGreaterThanOrEqual(before - 1);
    expect(timestamp).toBeLessThanOrEqual(Date.now() + 1);
  });
});
