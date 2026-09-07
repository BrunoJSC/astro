import { join } from "node:path";

/**
 * Loading an entry point with a controlled environment.
 *
 * Every module in this package calls `createEnv` at MODULE SCOPE. That is the
 * whole design -- `next.config.ts`, `instrumentation.ts`, `app.config.ts` and
 * `drizzle.config.ts` all rely on a bare `import` being enough to abort a bad
 * build -- and it is also what makes the package hard to test: a normal import
 * runs once, against whatever the test runner's environment happened to be.
 *
 * So each case gets a fresh module instance. The query string is what does it:
 * Bun keys its module registry by specifier, so `?case=3` is a different module
 * to `?case=2` and its top-level code runs again. `mock.module` would not help
 * here -- the thing under test IS the top-level execution.
 */

const SRC = join(import.meta.dir, "../../src");

/** Everything this package reads. Cleared before each case so nothing leaks in. */
const OWNED = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "CORS_ORIGINS",
  "DATABASE_URL",
  "DIRECT_URL",
  "EXPO_PUBLIC_API_URL",
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_APP_URL",
  "PORT",
  "REDIS_URL",
  "SKIP_ENV_VALIDATION",
];

/** A complete, valid server environment. Cases override one key at a time. */
export function validServer(): Record<string, string> {
  return {
    BETTER_AUTH_SECRET: "a-secret-of-at-least-thirty-two-chars",
    BETTER_AUTH_URL: "http://localhost:3001",
    DATABASE_URL: "postgres://user@localhost:5432/astro",
  };
}

/** A complete, valid client environment. */
export function validClient(): Record<string, string> {
  return { NEXT_PUBLIC_API_URL: "http://localhost:3001" };
}

export function validNative(): Record<string, string> {
  return { EXPO_PUBLIC_API_URL: "http://localhost:3001" };
}

export type Outcome<T> =
  | { ok: true; value: T }
  | { message: string; ok: false };

let counter = 0;

/**
 * Imports one entry point with exactly the given variables set.
 *
 * `null` removes a variable rather than emptying it: `emptyStringAsUndefined`
 * makes `""` behave as missing INSIDE the schema, but the two are different
 * inputs and the distinction is worth being able to express.
 *
 * The previous environment is restored afterwards, including `NODE_ENV`, which
 * `bun test` sets to "test" and the shared schema validates.
 */
export async function load<T = Record<string, unknown>>(
  entry: "client" | "native" | "server",
  variables: Record<string, string | null>,
  exportName = entry === "server" ? "env" : `${entry}Env`,
  browser = false
): Promise<Outcome<T>> {
  const saved = { ...process.env };

  for (const key of OWNED) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(variables)) {
    if (value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  counter += 1;
  /*
   * `window` is set around the IMPORT, not around the later access, and that is
   * not a detail. `@t3-oss/env-core` computes `isServer` once inside
   * `createEnv` -- `typeof window === "undefined"` -- and the proxy it returns
   * uses that captured value forever. Setting `window` afterwards changes
   * nothing, which an earlier version of these tests assumed and got wrong.
   */
  const globals = globalThis as { window?: unknown };
  if (browser) {
    globals.window = {};
  }

  try {
    const module = (await import(
      `${SRC}/${entry}.ts?case=${counter}`
    )) as Record<string, T>;
    const value = module[exportName];
    if (value === undefined) {
      return { message: `${entry}.ts exports no ${exportName}`, ok: false };
    }
    return { ok: true, value };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  } finally {
    if (browser) {
      globals.window = undefined;
    }
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}

/** The value, or a failure with the schema's message attached. */
export function expectLoaded<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) {
    throw new Error(
      `expected the schema to accept this, got: ${outcome.message}`
    );
  }
  return outcome.value;
}

export interface Schemas {
  client: Record<string, Validator>;
  desktop: Record<string, Validator>;
  native: Record<string, Validator>;
  server: Record<string, Validator>;
  shared: Record<string, Validator>;
}

/** The zod validators a schema map holds. Only `safeParse` is used here. */
export interface Validator {
  safeParse: (value: unknown) => { success: boolean };
}

/**
 * The schema maps, without tripping the validation their modules perform.
 *
 * Every entry point calls `createEnv` at module scope, so a plain
 * `import { serverSchema } from "../../src/server"` throws in a test process
 * that has no real environment -- the import runs the validation whether or
 * not the schema map is what you wanted.
 *
 * Loaded under a complete environment instead, and restored afterwards.
 * `SKIP_ENV_VALIDATION` would also work and is deliberately not used: it is
 * process-global, `bun test` runs every file of a suite in one process, and a
 * leaked "skip" would quietly turn `validation.test.ts`'s failure cases green.
 */
export async function loadSchemas(): Promise<Schemas> {
  const saved = { ...process.env };
  Object.assign(process.env, validServer(), validClient(), validNative());

  counter += 1;
  try {
    const [client, desktop, native, server, shared] = await Promise.all([
      import(`${SRC}/client.ts?schemas=${counter}`),
      import(`${SRC}/desktop.ts?schemas=${counter}`),
      import(`${SRC}/native.ts?schemas=${counter}`),
      import(`${SRC}/server.ts?schemas=${counter}`),
      import(`${SRC}/shared.ts?schemas=${counter}`),
    ]);

    return {
      client: client.clientSchema,
      desktop: desktop.desktopSchema,
      native: native.nativeSchema,
      server: server.serverSchema,
      shared: shared.sharedSchema,
    };
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}
