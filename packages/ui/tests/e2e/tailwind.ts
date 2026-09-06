import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tailwind from "@tailwindcss/postcss";
import postcss from "postcss";

/**
 * Compiles `src/styles/globals.css` the way an app does.
 *
 * Through `@tailwindcss/postcss`, which is exactly the plugin
 * `apps/web/postcss.config.mjs` and `apps/desktop/postcss.config.mjs` load. A
 * different compiler would prove something the apps do not do.
 *
 * The `base` is the subtle part, and getting it wrong made an earlier version of
 * this suite assert nothing at all. v4's automatic source detection does not
 * scan `base` -- it walks UP from `base` looking for a project root, stops at
 * the `.git` directory, and scans the whole monorepo from there. Every class in
 * the repository is therefore a candidate no matter what a test passes in, so
 * every `expect(css).toContain(...)` passed for a reason unrelated to the thing
 * it named.
 *
 * Pointing `base` at an empty directory outside the repository is what makes
 * the input controlled: detection finds no `.git`, scans an empty tree, and the
 * only candidates left are the ones `globals.css` declares and the ones a test
 * passes explicitly. Verified by mutation -- see `styles.test.ts`.
 */

const ISOLATED = mkdtempSync(join(tmpdir(), "repo-ui-css-"));

export const ENTRY = join(import.meta.dir, "../../src/styles/globals.css");

export async function build(
  candidates: string[] = [],
  entry: string = ENTRY,
): Promise<string> {
  const result = await postcss([tailwind({ base: ISOLATED })]).process(
    `@import "${entry}";\n${asSource(candidates)}`,
    { from: join(ISOLATED, "probe.css") },
  );

  return result.css;
}

/** `@source inline(...)` is v4's way of naming candidates with no file to scan. */
function asSource(candidates: string[]): string {
  return candidates.length > 0
    ? `@source inline("${candidates.join(" ")}");`
    : "";
}

/**
 * The compiled CSS with selector escapes removed, for `includes` checks.
 *
 * Tailwind escapes the punctuation in a class name, so `has-[>svg]:px-3` is
 * emitted as `.has-\[\>svg\]\:px-3`. Dropping the backslashes turns the
 * stylesheet back into something a class name can be looked up in directly.
 */
export function unescaped(css: string): string {
  return css.replace(/\\(.)/g, "$1");
}

/** Whether the compiler emitted a rule for this exact class. */
export function emits(css: string, className: string): boolean {
  return unescaped(css).includes(`.${className}`);
}
