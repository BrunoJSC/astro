import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BuildResult, buildOnce, runBuild, WEB } from "./helpers";

/**
 * `next build`, run for real.
 *
 * Everything this app is made of only meets at build time: five workspace
 * packages compiled from raw TypeScript by `transpilePackages`, the App
 * Router's Server/Client split, Tailwind through Next's PostCSS, and the env
 * schema imported by `next.config.ts`. A type-check proves none of it.
 */

describe("the production build", () => {
  let build: BuildResult;

  beforeAll(async () => {
    build = await buildOnce();
  }, 300_000);

  it("succeeds", () => {
    expect(build.output).toContain("Compiled successfully");
    expect(build.exitCode).toBe(0);
  });

  it("type-checks as part of the build, not only in check-types", () => {
    // `experimental.useTypeScriptCli` -- the build runs tsc itself, so a type
    // error fails the build even where `bun run check-types` was skipped.
    expect(build.output).toContain("Finished TypeScript");
  });

  it("prerenders every route as static", () => {
    /*
     * `cacheComponents: true` is on, and the routes have no dynamic data, so
     * all three must come out static. One turning dynamic means something in
     * the tree started reading a request -- cookies, headers, searchParams --
     * and that is a change in how the app is served, not a detail.
     */
    const manifest = JSON.parse(
      readFileSync(join(WEB, ".next/prerender-manifest.json"), "utf8"),
    ) as { routes: Record<string, unknown> };

    expect(Object.keys(manifest.routes).sort()).toEqual([
      "/",
      "/_global-error",
      "/_not-found",
    ]);
  });

  it("compiles the workspace packages rather than failing on their types", () => {
    /*
     * `@repo/ui` ships raw `.tsx` -- its `exports` point straight at `src/`
     * with no build step -- and this is where that either works or does not.
     *
     * Asserted on the output, not on `transpilePackages` being listed. Deleting
     * that option leaves this test green: under Turbopack a workspace
     * dependency's TypeScript is compiled anyway. What must hold is the result
     * -- the Button's classes are in the prerendered HTML, which cannot happen
     * unless the package compiled.
     */
    const html = readFileSync(join(WEB, ".next/server/app/index.html"), "utf8");

    expect(html).toContain("inline-flex");
    expect(html).toContain("bg-primary");
  });
});

describe("build-time environment validation", () => {
  it("aborts when a server variable is invalid, and names it", async () => {
    /*
     * What `import "@repo/env/server"` at the top of `next.config.ts` buys:
     * the build stops before emitting anything, instead of shipping a bundle
     * that fails on the first request that needs the value.
     *
     * It also pins the precedence every other test here depends on. `.env` in
     * this directory holds a VALID secret; this build fails, so the value
     * passed in `process.env` is the one that reached the schema. Were it the
     * other way round, the sentinels in `bundle.test.ts` would be searching
     * the output for strings that were never in it.
     */
    const build = await runBuild({ BETTER_AUTH_SECRET: "too-short" });

    expect(build.exitCode).not.toBe(0);
    expect(build.output).toContain("Invalid environment variables");
    expect(build.output).toContain("BETTER_AUTH_SECRET");
  }, 300_000);
});
