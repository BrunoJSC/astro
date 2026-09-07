import { beforeAll, describe, expect, it } from "bun:test";
import {
  type CliResult,
  config,
  configOnce,
  runConfig,
  runExport,
  source,
} from "./helpers";

/**
 * `app.config.ts`, evaluated.
 *
 * The file is TypeScript that Expo runs in Node before anything is bundled, and
 * `check-types` never executes it. What it does at runtime -- merge `app.json`,
 * and validate the environment through two ordered side-effect imports -- is
 * only observable by running the CLI.
 */

describe("the resolved Expo config", () => {
  let resolved: Record<string, unknown>;

  beforeAll(async () => {
    resolved = config(await configOnce());
  }, 300_000);

  it("merges app.json rather than replacing it", () => {
    // `app.config.ts` spreads `config`, so everything static still has to be
    // there. A dynamic config that shadowed app.json would drop the plugins
    // and the app would build without expo-router registered.
    expect(resolved.name).toBe("Astro");
    expect(resolved.slug).toBe("astro");
    expect(resolved.newArchEnabled).toBe(true);
  });

  it("keeps the native identifiers a store release is tied to", () => {
    /*
     * These two cannot change after the first submission -- they are the app's
     * identity to both stores. Worth a test purely because a rename is easy,
     * looks harmless in review, and is irreversible once published.
     */
    expect(resolved.ios).toMatchObject({ bundleIdentifier: "com.astro.app" });
    expect(resolved.android).toMatchObject({ package: "com.astro.app" });
  });

  it("registers the plugins the native modules need", () => {
    /*
     * `expo-secure-store` is in this list because the session token lives
     * there. Without the plugin the config plugin never runs, and on a
     * development build the module is missing at runtime -- which surfaces as
     * a failed sign-in, not as a build error.
     */
    const plugins = (resolved.plugins ?? []) as (string | [string, unknown])[];
    const names = plugins.map((plugin) =>
      Array.isArray(plugin) ? plugin[0] : plugin,
    );

    expect(names).toContain("expo-router");
    expect(names).toContain("expo-secure-store");
    expect(names).toContain("expo-system-ui");
  });

  it("uses the same scheme the auth client redirects to", () => {
    /*
     * A cross-file invariant nothing else can catch. `expoClient({ scheme })`
     * in `lib/auth-client.ts` is the deep link an OAuth provider sends the
     * user back to, and it is a string literal in a different file from the
     * `expo.scheme` that registers it with the OS.
     *
     * Change one and sign-in stops returning to the app -- with no error
     * anywhere, because from the provider's side the redirect succeeded.
     */
    const declared =
      source("lib/auth-client.ts").match(/scheme:\s*"([^"]+)"/)?.[1];

    expect(declared).toBeTruthy();
    expect(resolved.scheme).toBe(declared);
  });
});

describe("build-time environment validation", () => {
  it("aborts on a malformed API URL", async () => {
    /*
     * What the `@repo/env/native` import in `app.config.ts` buys. Metro
     * validates nothing: it inlines whatever it finds, `undefined` included,
     * so without this the failure moves to the device -- a released binary
     * that requests `undefined/api` and cannot be fixed without a new build.
     */
    const result = await runConfig({ EXPO_PUBLIC_API_URL: "not-a-url" });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Invalid environment variables");
    // The trace names the schema, which is the next place to look.
    expect(result.output).toContain("packages/env/src/native.ts");
  }, 300_000);

  it("aborts when it is missing entirely", async () => {
    // `emptyStringAsUndefined` -- an empty assignment in a `.env` file is a
    // missing variable, not a valid empty string.
    const result = await runConfig({ EXPO_PUBLIC_API_URL: "" });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("Invalid environment variables");
  }, 300_000);

  it("names the offending variable when a BUILD fails, unlike expo config", async () => {
    /*
     * The asymmetry, measured, because it decides what the previous two tests
     * can assert.
     *
     * `expo config` reports only "Invalid environment variables" -- the CLI
     * does not surface the schema's own `console.error`. `expo export` does,
     * with the key, the format it expected and the message. Since a build is
     * where this actually fires, the useful message is present where it
     * matters; a developer running `expo config` to debug gets less.
     */
    const result = await runExport({ EXPO_PUBLIC_API_URL: "not-a-url" });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("EXPO_PUBLIC_API_URL");
    expect(result.output).toContain("Invalid URL");
  }, 600_000);

  it("still evaluates when validation is explicitly skipped", async () => {
    // `skipValidation` exists for CI steps that build without a real
    // environment. If this stopped working, that escape hatch is gone.
    const result: CliResult = await runConfig({
      EXPO_PUBLIC_API_URL: "not-a-url",
      SKIP_ENV_VALIDATION: "1",
    });

    expect(result.exitCode).toBe(0);
  }, 300_000);
});
