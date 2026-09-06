import { describe, expect, it } from "bun:test";
import { createQueryClient, QUERY_DEFAULTS } from "../../src/plugins/query";

describe("createQueryClient", () => {
  it("applies the shared cache windows", () => {
    const defaults = createQueryClient().getDefaultOptions().queries;
    expect(defaults?.staleTime).toBe(QUERY_DEFAULTS.staleTime);
    expect(defaults?.gcTime).toBe(QUERY_DEFAULTS.gcTime);
  });

  it("keeps gcTime above staleTime", () => {
    // Otherwise entries are collected while still considered fresh, and every
    // read misses the cache it was supposed to hit.
    expect(QUERY_DEFAULTS.gcTime).toBeGreaterThan(QUERY_DEFAULTS.staleTime);
  });

  it("returns a new instance per call", () => {
    // A shared server-side client would leak one request's data to the next.
    expect(createQueryClient()).not.toBe(createQueryClient());
  });
});
