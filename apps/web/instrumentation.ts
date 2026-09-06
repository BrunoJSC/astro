/**
 * Runtime environment validation, at server startup.
 *
 * `next.config.ts` already validates at build time, but that runs against the
 * BUILD environment -- typically CI, with placeholder values. This hook runs
 * against the environment the server actually boots with, which is the one
 * that matters and is frequently a different set of values entirely. A
 * container started with a missing DATABASE_URL fails here, immediately and
 * with the offending key named, instead of on the first request that needs it.
 *
 * The dynamic import is required: the module must not be evaluated in the Edge
 * runtime, where server-only env is absent by design.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("@repo/env/server");
  }
}
