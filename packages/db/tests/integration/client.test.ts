import { describe, expect, it } from "vitest";
import { db, pool } from "../../src/client";
import { db as edgeDb } from "../../src/edge";
import * as schema from "../../src/schema";

describe("@repo/db default client (neon-serverless)", () => {
  it("builds a drizzle instance over a Neon WebSocket pool", () => {
    expect(pool).toBeDefined();
    expect(typeof db.select).toBe("function");
  });

  it("supports interactive transactions", () => {
    // The reason this entry point exists at all: a WebSocket session can hold
    // a transaction open across statements, which HTTP cannot.
    expect(typeof db.transaction).toBe("function");
  });

  it("exposes the schema to the query builder", () => {
    expect(Object.keys(schema).length).toBeGreaterThan(0);
  });
});

describe("@repo/db/edge (neon-http)", () => {
  it("builds a stateless client", () => {
    expect(typeof edgeDb.select).toBe("function");
  });

  it("throws on transaction() rather than omitting it", async () => {
    /*
     * The trap this guards: `transaction` is present and type-checks, so the
     * failure surfaces only at runtime, in production, under load. Asserting
     * the exact message keeps src/edge.ts's documentation honest.
     */
    expect(typeof edgeDb.transaction).toBe("function");
    await expect(edgeDb.transaction(async () => undefined)).rejects.toThrow(
      "No transactions support in neon-http driver"
    );
  });

  it("offers batch() as the atomic primitive instead", () => {
    expect(typeof edgeDb.batch).toBe("function");
  });
});

describe("neon driver configuration", () => {
  it("routes single pool queries over fetch", async () => {
    const { neonConfig } = await import("@neondatabase/serverless");
    // The live cold-start optimisation. `fetchConnectionCache` is deprecated
    // and ignored in v1, so this is what actually does the work.
    expect(neonConfig.poolQueryViaFetch).toBe(true);
  });

  it("switches to the plaintext proxy protocol for local hosts", async () => {
    const { neonConfig } = await import("@neondatabase/serverless");
    // tests/setup.ts points DATABASE_URL at localhost, so importing the client
    // above must have applied the local settings.
    expect(neonConfig.useSecureWebSocket).toBe(false);
    expect(typeof neonConfig.wsProxy).toBe("function");
  });
});
