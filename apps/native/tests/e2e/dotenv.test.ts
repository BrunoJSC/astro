import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE, runExport, SENTINEL } from "./helpers";

/**
 * `env-preload.ts`, and the ordering problem it exists for.
 *
 * The module is three lines and looks removable. It is not: `expo export`
 * evaluates `app.config.ts` BEFORE applying the project's `.env` files, so
 * without it the schema runs against an environment that has none of them and
 * a valid configuration fails to build.
 *
 * It also cannot be a function call at the top of `app.config.ts`. ESM hoists
 * every `import` above the statements in a file, so the call would run after
 * the schema import it is supposed to precede. Side-effect imports run in
 * source order, which is why it is a module.
 */

/**
 * `.env.development` is loaded for the mode `env-preload` passes, and is the
 * least likely of Expo's candidates to be a file a developer already keeps.
 * The suite refuses to touch one that exists rather than overwrite it.
 */
const DOTENV = join(NATIVE, ".env.development");
const preexisting = existsSync(DOTENV);

if (preexisting) {
  process.stderr.write(
    `\n[native/dotenv] skipped: ${DOTENV} already exists.\n` +
      "  The test writes that file; it will not overwrite yours.\n\n",
  );
}

afterAll(() => {
  if (!preexisting) {
    rmSync(DOTENV, { force: true });
  }
});

describe.skipIf(preexisting)("loading .env before the schema runs", () => {
  it("exports with the value in a dotenv file and nothing in the environment", async () => {
    /*
     * The measurement this file is named after. With `env-preload.ts` in
     * place the export succeeds; deleting that import from `app.config.ts`
     * makes this exact scenario fail with "Invalid environment variables",
     * because the schema then sees an unset variable.
     *
     * The variable is REMOVED rather than emptied. Expo's loader leaves an
     * already-present variable alone, so `""` would block the file from
     * supplying anything and the test would fail for the wrong reason -- it
     * did, first time round.
     */
    /*
     * The SAME value the rest of the suite passes in the environment, and that
     * is not tidiness -- it is required.
     *
     * Metro inlines `process.env.EXPO_PUBLIC_*` at transform time and its
     * cache does NOT key on the value. An export here with a different URL
     * therefore caches modules carrying it, and the next export -- a different
     * process, a different environment -- reuses those modules and ships the
     * stale value. Measured: with a distinct URL in this file, the bundle
     * `bundle.test.ts` asserts on came out holding it instead of the sentinel.
     *
     * The same trap applies outside the tests. Changing EXPO_PUBLIC_API_URL
     * and rebuilding is not enough; the cache has to be cleared
     * (`expo export --clear`) or the old value ships.
     */
    writeFileSync(DOTENV, `EXPO_PUBLIC_API_URL=${SENTINEL.apiUrl}\n`);

    const result = await runExport({
      EXPO_PUBLIC_API_URL: null,
      NODE_ENV: "development",
    });

    expect(result.output).not.toContain("Invalid environment variables");
    expect(result.exitCode).toBe(0);
  }, 600_000);
});
