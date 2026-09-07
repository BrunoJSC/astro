import { describe, expect, it } from "bun:test";
import {
  expectLoaded,
  load,
  validClient,
  validNative,
  validServer,
} from "./helpers";

/**
 * The schemas, run at import time.
 *
 * This package has never been tested. Its whole contract is that a bare
 * `import` aborts a bad build -- `next.config.ts`, `apps/native/app.config.ts`,
 * `instrumentation.ts` and `drizzle.config.ts` each depend on that and nothing
 * else -- so the contract is only observable by importing it.
 */

describe("the server schema accepts a good environment", () => {
  it("returns the parsed values, not the raw strings", async () => {
    const env = expectLoaded(
      await load<Record<string, unknown>>("server", {
        ...validServer(),
        PORT: "4000",
      })
    );

    // `z.coerce.number()`. `process.env` values are strings, and a `PORT` that
    // stayed a string reaches `Bun.serve` as one and binds nothing.
    expect(env.PORT).toBe(4000);
    expect(typeof env.PORT).toBe("number");
  });

  it("splits CORS_ORIGINS into a list, so the server never re-parses it", async () => {
    const env = expectLoaded(
      await load<Record<string, unknown>>("server", {
        ...validServer(),
        CORS_ORIGINS: "http://localhost:3000, http://localhost:5173",
      })
    );

    // Trimmed, because a space after the comma is the normal way to write it
    // and an origin with a leading space matches nothing.
    expect(env.CORS_ORIGINS).toEqual([
      "http://localhost:3000",
      "http://localhost:5173",
    ]);
  });

  it("supplies the defaults the deployment does not have to state", async () => {
    const env = expectLoaded(
      await load<Record<string, unknown>>("server", validServer())
    );

    expect(env.PORT).toBe(3001);
    expect(env.REDIS_URL).toBe("redis://localhost:6379");
    expect(env.CORS_ORIGINS).toEqual(["http://localhost:3000"]);
  });

  it("leaves DIRECT_URL undefined rather than inventing one", async () => {
    /*
     * Optional on purpose. It bypasses Neon's pooler for DDL; on a plain
     * Postgres there is no pooler to bypass, and drizzle-kit falls back to
     * DATABASE_URL. A default here would point migrations at a URL nobody
     * configured.
     */
    const env = expectLoaded(
      await load<Record<string, unknown>>("server", validServer())
    );

    expect(env.DIRECT_URL).toBeUndefined();
  });
});

describe("the server schema refuses a bad one", () => {
  it("refuses a missing DATABASE_URL", async () => {
    const outcome = await load("server", {
      ...validServer(),
      DATABASE_URL: null,
    });

    expect(outcome.ok).toBe(false);
  });

  it("refuses a DATABASE_URL that is not a URL", async () => {
    // `postgres://...` typed without the scheme is the common version of this,
    // and it fails at connect time with a driver error that names nothing.
    const outcome = await load("server", {
      ...validServer(),
      DATABASE_URL: "user@localhost:5432/astro",
    });

    expect(outcome.ok).toBe(false);
  });

  it("refuses a secret shorter than thirty-two characters", async () => {
    /*
     * The length is not decoration: Better Auth derives its signing key from
     * this string. A short one is a forgeable session cookie, and nothing about
     * the running app looks different.
     */
    const outcome = await load("server", {
      ...validServer(),
      BETTER_AUTH_SECRET: "too-short",
    });

    expect(outcome.ok).toBe(false);
  });

  it("accepts one of exactly thirty-two", async () => {
    // The boundary, in the direction that must pass -- an off-by-one here
    // rejects a correctly generated secret and looks like a config error.
    const outcome = await load("server", {
      ...validServer(),
      BETTER_AUTH_SECRET: "a".repeat(32),
    });

    expect(outcome.ok).toBe(true);
  });

  it("treats an empty assignment as missing", async () => {
    /*
     * `emptyStringAsUndefined`. `DATABASE_URL=` in a `.env` file is how a
     * variable gets half-deleted, and without this it would parse as the empty
     * string and fail much later with an unrelated message.
     */
    const outcome = await load("server", {
      ...validServer(),
      DATABASE_URL: "",
    });

    expect(outcome.ok).toBe(false);
  });

  it("refuses a port outside the range a port can be", async () => {
    for (const port of ["0", "70000", "-1", "8080.5"]) {
      const outcome = await load("server", { ...validServer(), PORT: port });
      expect(outcome.ok, `PORT=${port} must be refused`).toBe(false);
    }
  });

  it("refuses an empty CORS allowlist instead of defaulting to a wildcard", async () => {
    // The failure mode this prevents: an empty value silently becoming "allow
    // everything", which is the shape most CORS bugs take.
    const outcome = await load("server", {
      ...validServer(),
      CORS_ORIGINS: "",
    });

    expect(outcome.ok).toBe(true);
    // Empty means unset, and unset means the documented default -- never a
    // wildcard and never an empty list.
    const env = expectLoaded(outcome) as Record<string, unknown>;
    expect(env.CORS_ORIGINS).toEqual(["http://localhost:3000"]);
  });
});

describe("the escape hatch", () => {
  it("skips validation entirely when asked", async () => {
    /*
     * `SKIP_ENV_VALIDATION` exists for build steps that compile without a real
     * environment -- a Docker image built in CI, `next build` on a runner. It
     * has to keep working, and it has to be the ONLY way past the schema.
     */
    const outcome = await load("server", {
      ...validServer(),
      BETTER_AUTH_SECRET: "obviously-too-short",
      SKIP_ENV_VALIDATION: "1",
    });

    expect(outcome.ok).toBe(true);
  });

  it("is off unless it is set, not merely falsy", async () => {
    // `Boolean(process.env.SKIP_ENV_VALIDATION)`: the string "false" is truthy,
    // so setting it to "false" also skips. Surprising, and worth pinning so a
    // future change to `=== "true"` is a deliberate one.
    const outcome = await load("server", {
      ...validServer(),
      BETTER_AUTH_SECRET: "short",
      SKIP_ENV_VALIDATION: "false",
    });

    expect(outcome.ok).toBe(true);
  });
});

describe("the client and native schemas", () => {
  it("accepts the public API URL each bundler inlines", async () => {
    const client = expectLoaded(
      await load<Record<string, unknown>>("client", validClient(), "clientEnv")
    );
    const native = expectLoaded(
      await load<Record<string, unknown>>("native", validNative(), "nativeEnv")
    );

    expect(client.NEXT_PUBLIC_API_URL).toBe("http://localhost:3001");
    expect(native.EXPO_PUBLIC_API_URL).toBe("http://localhost:3001");
  });

  it("refuses a missing one, because the bundler will not", async () => {
    /*
     * Metro and Next replace `process.env.*_PUBLIC_*` by static substitution
     * and validate nothing -- `undefined` is inlined as happily as a URL. This
     * schema is the only thing between an unset variable and a shipped binary
     * that requests `undefined/api`.
     */
    expect((await load("client", {}, "clientEnv")).ok).toBe(false);
    expect((await load("native", {}, "nativeEnv")).ok).toBe(false);
  });

  it("leaves the optional app URL alone", async () => {
    const client = expectLoaded(
      await load<Record<string, unknown>>("client", validClient(), "clientEnv")
    );

    expect(client.NEXT_PUBLIC_APP_URL).toBeUndefined();
  });
});
