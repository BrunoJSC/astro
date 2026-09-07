import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 */
const DOTENV = join(NATIVE, ".env.development");

/**
 * Exactly what this test writes, defined once so the file can be recognised
 * again. The value is the suite's own sentinel for a second reason -- see the
 * comment on the write below.
 */
const CONTENTS = `EXPO_PUBLIC_API_URL=${SENTINEL.apiUrl}\n`;

/**
 * Whether the file on disk belongs to somebody else.
 *
 * Not merely "does it exist". A run killed before its `afterAll` leaves this
 * file behind, and a bare existence check then skips this test on every later
 * run -- silently, forever, which is the failure this whole suite exists to
 * catch. Found exactly that way: a session ended mid-run and the next full
 * `turbo run test` reported `[native/dotenv] skipped` as though that were
 * normal.
 *
 * Matching on the contents distinguishes the two cases. Residue this test
 * wrote is its own to reuse; anything else is a developer's file and is left
 * alone.
 */
const foreign = existsSync(DOTENV) && readFileSync(DOTENV, "utf8") !== CONTENTS;

if (foreign) {
  process.stderr.write(
    `\n[native/dotenv] skipped: ${DOTENV} exists and is not ours.\n` +
      "  The test writes that file; it will not overwrite yours.\n\n",
  );
}

afterAll(() => {
  if (!foreign) {
    rmSync(DOTENV, { force: true });
  }
});

describe.skipIf(foreign)("loading .env before the schema runs", () => {
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
    writeFileSync(DOTENV, CONTENTS);

    const result = await runExport({
      EXPO_PUBLIC_API_URL: null,
      NODE_ENV: "development",
    });

    expect(result.output).not.toContain("Invalid environment variables");
    expect(result.exitCode).toBe(0);
  }, 600_000);
});
