import { describe, expect, it } from "bun:test";
import {
  expectLoaded,
  load,
  validClient,
  validNative,
  validServer,
} from "./helpers";

/**
 * The line between what the server may read and what a bundle may carry.
 *
 * This is the package's reason to exist. Everything else it does -- coercing a
 * port, defaulting a Redis URL -- is convenience; keeping `DATABASE_URL` out
 * of a browser bundle is not.
 */

/** T3 Env's message, which is the same for both sides of the boundary. */
const SERVER_ON_CLIENT = /server-side environment variable on the client/;

/** Constructs the module as a browser would: `window` defined at createEnv. */
const BROWSER = true;

describe("the client bundle cannot reach a server variable", () => {
  it("exposes only the public keys and NODE_ENV", async () => {
    /*
     * Enumerated rather than spot-checked. A server key appearing here is a
     * secret in a browser bundle, and the list is short enough that stating it
     * exactly costs nothing and catches everything.
     */
    const client = expectLoaded(
      await load("client", validClient(), "clientEnv")
    );

    expect(Object.keys(client).sort()).toEqual([
      "NEXT_PUBLIC_API_URL",
      "NEXT_PUBLIC_APP_URL",
      "NODE_ENV",
    ]);
  });

  it("throws for a server key in a browser", async () => {
    const client = expectLoaded(
      await load<Record<string, unknown>>(
        "client",
        validClient(),
        "clientEnv",
        BROWSER
      )
    );

    expect(() => client.DATABASE_URL).toThrow(SERVER_ON_CLIENT);
    expect(() => client.BETTER_AUTH_SECRET).toThrow(SERVER_ON_CLIENT);
  });

  it("returns undefined for the same key on a server, without complaint", async () => {
    /*
     * The surprise, and the reason the previous test says "in a browser".
     *
     * `isServer` is decided ONCE, inside `createEnv`, from `typeof window`. An
     * SSR pass, a build step or a test constructs `clientEnv` on a server, and
     * the proxy it returns hands back `undefined` for a server key rather than
     * throwing. The value then flows onward and fails somewhere unrelated.
     *
     * So this is a browser-side protection, not a universal one -- which is
     * exactly how the prerender leak in `apps/web` got missed.
     */
    const client = expectLoaded(
      await load<Record<string, unknown>>("client", validClient(), "clientEnv")
    );

    expect(client.DATABASE_URL).toBeUndefined();
  });

  it("does the same on the native side", async () => {
    const native = expectLoaded(
      await load<Record<string, unknown>>(
        "native",
        validNative(),
        "nativeEnv",
        BROWSER
      )
    );

    expect(Object.keys(native).sort()).toEqual([
      "EXPO_PUBLIC_API_URL",
      "NODE_ENV",
    ]);
    expect(() => native.DATABASE_URL).toThrow(SERVER_ON_CLIENT);
  });

  it("keeps each bundler's prefix to itself", async () => {
    /*
     * `clientPrefix` takes ONE prefix, which is why `./client` and `./native`
     * are separate modules rather than one with both. Next inlines
     * `NEXT_PUBLIC_*`; Metro inlines `EXPO_PUBLIC_*`. A shared module would
     * leave whichever bundler is not running with undefined values.
     */
    const client = expectLoaded(
      await load<Record<string, unknown>>(
        "client",
        { ...validClient(), EXPO_PUBLIC_API_URL: "http://expo.invalid" },
        "clientEnv",
        BROWSER
      )
    );

    expect(client.NEXT_PUBLIC_API_URL).toBe("http://localhost:3001");
    // In the environment, absent from this schema: the other bundler's
    // variable is not reachable through this entry point.
    expect(Object.keys(client)).not.toContain("EXPO_PUBLIC_API_URL");
    expect(() => client.EXPO_PUBLIC_API_URL).toThrow(SERVER_ON_CLIENT);
  });
});

describe("the server guard, and exactly when it fires", () => {
  it("does NOT fire on import, even in a browser", async () => {
    /*
     * Measured, and it is the mechanism behind the leak found in `apps/web`.
     *
     * The comment in `src/server.ts` says importing this module from client
     * code "throws at runtime". It does not: the import succeeds and the guard
     * fires on property ACCESS. That distinction is the whole bug -- during a
     * Next prerender a Client Component runs on the SERVER, where `window` is
     * undefined, so the access succeeds too and the value is rendered into the
     * HTML every visitor downloads.
     *
     * `apps/web/tests/e2e/bundle.test.ts` catches the consequence. This pins
     * the cause, so nobody reads the guard as stronger than it is.
     */
    const outcome = await load("server", validServer(), "env", BROWSER);

    expect(outcome.ok).toBe(true);
  });

  it("fires on access when the module was built in a browser", async () => {
    const env = expectLoaded(
      await load<Record<string, unknown>>(
        "server",
        validServer(),
        "env",
        BROWSER
      )
    );

    expect(() => env.DATABASE_URL).toThrow(SERVER_ON_CLIENT);
    expect(() => env.BETTER_AUTH_SECRET).toThrow(SERVER_ON_CLIENT);
  });

  it("stays out of the way on a server", async () => {
    const env = expectLoaded(
      await load<Record<string, unknown>>("server", validServer())
    );

    expect(env.DATABASE_URL).toBe("postgres://user@localhost:5432/astro");
  });

  it("refuses even a shared key on the server env, for a reason worth knowing", async () => {
    /*
     * `NODE_ENV` is in `sharedSchema` so both halves can branch on it. Read
     * off `serverEnv` in a browser it still throws -- and the reason is
     * structural rather than a bug.
     *
     * T3 Env decides "is this a server-only key?" by checking the prefix and
     * the shared map, and it only does that when a `clientPrefix` is
     * configured. `serverEnv` declares none, so `isServerAccess` returns true
     * for everything: on the client, the whole object is refused rather than
     * partly readable. That is the safe direction, and it means a component
     * that wants `NODE_ENV` in the browser must take it from `clientEnv`.
     */
    const server = expectLoaded(
      await load<Record<string, unknown>>(
        "server",
        validServer(),
        "env",
        BROWSER
      )
    );

    expect(() => server.NODE_ENV).toThrow(SERVER_ON_CLIENT);
  });

  it("lets the client env read the same shared key in a browser", async () => {
    // The other half: `clientEnv` has a `clientPrefix`, so T3 Env can tell a
    // shared key from a secret, and `NODE_ENV` comes through.
    const client = expectLoaded(
      await load<Record<string, unknown>>(
        "client",
        validClient(),
        "clientEnv",
        BROWSER
      )
    );

    expect(client.NODE_ENV).toBeDefined();
  });
});

describe("the index module emits no runtime import", () => {
  it("re-exports types only, so importing it validates nothing", async () => {
    /*
     * `src/index.ts` is `export type` throughout. A value re-export would run
     * `./server`'s `createEnv` for anyone importing `@repo/env` -- including a
     * client bundle, which is how a whole schema ends up somewhere it must
     * not be. `verbatimModuleSyntax` erases the type exports entirely.
     *
     * Imported with NOTHING arranged: if any schema ran, it would throw here.
     */
    const module = await import("../../src/index.ts");

    expect(Object.keys(module)).toEqual([]);
  });
});
