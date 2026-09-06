import { describe, expect, it } from "bun:test";

describe("@repo/auth entry points", () => {
  it("keeps the barrel free of runtime exports", async () => {
    const mod = await import("../../src/index");
    // `index.ts` is types-only; importing it must not pull `./server` (which
    // reads server-only env) or `./client` into the bundle.
    expect(Object.keys(mod)).toHaveLength(0);
  });
});
