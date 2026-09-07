import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  browserReachable,
  buildOnce,
  prerendered,
  runBuild,
  SENTINEL,
  stylesheet,
  WEB,
} from "./helpers";

/**
 * What the build actually hands to a browser.
 *
 * The App Router's Server/Client boundary is a rule about which files run
 * where, and nothing enforces it from the outside. These tests read the
 * emitted output instead of trusting the rule.
 */

/** A token resolved to a hex literal, e.g. `--primary:#171717`. */
const TOKEN_AS_HEX = /--primary:\s*#[0-9a-f]{3,8}/i;
/** The same token left as a bare oklch value -- the no-fallback case. */
const TOKEN_AS_OKLCH = /--primary:\s*oklch\(\s*[.\d]/i;

describe("nothing server-side reaches the browser", () => {
  let assets: { path: string; text: string }[];

  beforeAll(async () => {
    await buildOnce();
    assets = browserReachable();
  }, 300_000);

  it("has assets to search in the first place", () => {
    // Without this, every assertion below passes on an empty list -- which is
    // exactly what a renamed output directory would produce.
    expect(assets.length).toBeGreaterThan(10);
    expect(assets.some((asset) => asset.path.endsWith(".html"))).toBe(true);
    expect(assets.some((asset) => asset.path.endsWith(".js"))).toBe(true);
  });

  it("leaks neither the auth secret nor the database URL", () => {
    /*
     * Both halves of the output are searched, and the second one is the half
     * that matters here.
     *
     * A `"use client"` component that imports `@repo/env/server` does NOT
     * fail this build -- measured. T3 Env's guard is `typeof window`, and
     * during prerender a Client Component runs on the SERVER, so the guard
     * sees a server and hands over the value. The secret then never appears in
     * a JS chunk at all: it is baked into `.next/server/app/<route>.html`,
     * which is the file every visitor downloads.
     *
     * Searching only `.next/static` would therefore have found nothing and
     * reported success.
     */
    for (const secret of [SENTINEL.secret, SENTINEL.databaseUrl]) {
      const leaked = assets
        .filter((asset) => asset.text.includes(secret))
        .map((asset) => asset.path);

      expect(leaked, `${secret.slice(0, 12)}... must not ship`).toEqual([]);
    }
  });

  it("keeps the native and node-only packages out of the client bundle", () => {
    /*
     * `serverExternalPackages: ["argon2", "pg"]`. argon2 is a `.node` binary
     * reached through @repo/auth; bundling it breaks the addon resolution, and
     * shipping it to a browser is not possible at all.
     */
    const chunks = assets.filter(
      (asset) => asset.path.startsWith("static") && asset.path.endsWith(".js"),
    );

    for (const marker of ["argon2", "node:crypto", "pg-connection-string"]) {
      const found = chunks
        .filter((chunk) => chunk.text.includes(marker))
        .map((chunk) => chunk.path);

      expect(found, `${marker} must stay on the server`).toEqual([]);
    }
  });
});

describe("the design system survives the build", () => {
  beforeAll(async () => {
    await buildOnce();
  }, 300_000);

  it("emits a stylesheet carrying the tokens", () => {
    /*
     * The whole chain in one assertion: `app/globals.css` imports
     * `@repo/ui/styles`, Next's PostCSS runs `@tailwindcss/postcss` over it,
     * and the `@theme inline` block becomes real custom properties.
     */
    const css = stylesheet();

    expect(css).toContain("--primary");
    expect(css).toContain("--background");
  });

  it("downlevels the oklch PALETTE, which the source never says", () => {
    /*
     * Measured, and contrary to what reading `packages/ui` suggests.
     *
     * That file's palette is oklch throughout and its own test asserts so. The
     * tokens come out of a production build as a hex value plus a wider-gamut
     * `lab()` behind an `@supports` guard -- both the same colour, and the
     * browser takes whichever it understands.
     *
     * Turbopack's own CSS pipeline does this, not `experimental.optimizeCss` --
     * removing that option leaves the output unchanged, measured.
     */
    const css = stylesheet();

    expect(css).toMatch(TOKEN_AS_HEX);
    expect(css).toContain("lab(");
    // No token may be left as a bare oklch value: that is the case with no
    // fallback at all.
    expect(css).not.toMatch(TOKEN_AS_OKLCH);
  });

  it("does ship relative colour syntax, which cannot be downlevelled", () => {
    /*
     * `oklch(from var(--primary) .93 calc(c * .4) h)` -- the Bubble component
     * derives its tint from the primary token at render time. There is no
     * static value for Lightning CSS to precompute, so it survives the build
     * whole, and it arrived with the shadcn registry components rather than
     * from anything written here.
     *
     * Asserted rather than removed, because it is a real browser-support
     * decision and this is where it becomes visible. Relative colour syntax
     * needs Chrome 119+ or Safari 16.4+; `apps/desktop` bundles its own
     * Chromium so it is unconditional there, and on the web an older browser
     * drops the background rather than falling back to one.
     */
    const css = stylesheet();

    expect(css).toContain("oklch(from var(--primary)");
  });

  it("emits the utilities the app's own files use, not just the package's", () => {
    /*
     * `min-h-dvh` and `max-w-2xl` are written in `app/layout.tsx` and
     * `app/page.tsx` and appear nowhere in `@repo/ui`, so reaching the
     * stylesheet means this app's own tree was scanned.
     *
     * Which is the claim, and it stops there. Deleting `@source "."` from
     * `app/globals.css` does NOT fail this test -- measured -- because v4's
     * automatic detection walks up to the `.git` directory and scans the
     * monorepo, `app/` included. The directive is a floor for a build whose
     * root is somewhere else, not the mechanism at work here.
     */
    const css = stylesheet();

    expect(css).toContain("min-h-dvh");
    expect(css).toContain("max-w-2xl");
  });

  it("renders the page's buttons with the variants it asked for", () => {
    const html = prerendered("index");

    expect(html).toContain("Astro");
    for (const variant of ["bg-primary", "bg-secondary", "bg-destructive"]) {
      expect(html, `${variant} must reach the markup`).toContain(variant);
    }
  });

  it("resolves the caller's override on the page's last button", () => {
    /*
     * `<Button className={cn("h-12 w-full")} variant="outline">` -- the
     * override wins over the variant's `h-9`, through the real build.
     *
     * Scoped to that one element's class attribute. The page renders five
     * other buttons at the default size, so `h-9` appears nine times in this
     * document and a whole-file search would prove nothing.
     */
    const overridden = prerendered("index")
      .match(/class="([^"]*h-12[^"]*)"/)
      ?.at(1);

    expect(overridden).toBeTruthy();
    expect(overridden).toContain("w-full");
    expect(overridden).not.toContain("h-9");
    // The rest of the outline variant is untouched by the merge.
    expect(overridden).toContain("bg-background");
  });

  it("prerenders the not-found page with its link-as-button", () => {
    // Base UI's `render` prop plus `next/link`, resolved at build time.
    const html = prerendered("_not-found");

    expect(html).toContain("Page not found");
    expect(html).toContain('href="/"');
  });
});

describe("the server environment cannot be reached from a Client Component", () => {
  /*
   * Two builds, and the contrast between them is the point.
   *
   * `apps/web/lib/env.ts` carries `import "server-only"`, which Next treats as
   * a compiler marker rather than as a module -- "Next.js handles server-only
   * imports internally. The contents of these packages from NPM are not
   * used." A Client Component reaching it is a build error.
   *
   * The unguarded `@repo/env/server` is still importable and still leaks, and
   * that is not an oversight: `next.config.ts` and `instrumentation.ts` need
   * it, they run outside any client graph, and no export condition can tell
   * their case from a Client Component's SSR pass -- both resolve `default`.
   * `apps/web/biome.jsonc` is what keeps app code off it; this file records
   * why that rule has to exist.
   */

  /*
   * These two cases rebuild `.next` with an extra route in it, so they run
   * last on purpose -- `build.test.ts` asserts the exact prerendered route
   * list and would fail on the leftovers. Alphabetical file order puts it
   * first, and every run starts with `buildOnce()` rebuilding clean, so the
   * pollution never survives into another file or another run. Verified by
   * running the suite twice back to back.
   */
  const PROBE_DIR = join(WEB, "app/leak-probe");

  function writeProbe(from: string): void {
    mkdirSync(PROBE_DIR, { recursive: true });
    writeFileSync(
      join(PROBE_DIR, "page.tsx"),
      `"use client";\nimport { env } from "${from}";\n` +
        "export default function LeakProbe() {\n" +
        "  return <p>{env.BETTER_AUTH_SECRET}</p>;\n}\n",
    );
  }

  afterAll(() => {
    rmSync(PROBE_DIR, { force: true, recursive: true });
  });

  it("fails the build when it goes through the guarded entry", async () => {
    writeProbe("@/lib/env");

    const build = await runBuild();

    expect(build.exitCode).not.toBe(0);
    expect(build.output).toContain("server-only");
  }, 600_000);

  it("still compiles and still leaks through the unguarded one", async () => {
    /*
     * Asserted in the direction that documents the gap rather than hides it.
     * If this ever starts failing, Next has gained a way to tell the two
     * compilations apart and the lint rule can go.
     */
    writeProbe("@repo/env/server");

    const build = await runBuild();
    expect(build.exitCode).toBe(0);

    const leaked = browserReachable()
      .filter((asset) => asset.text.includes(SENTINEL.secret))
      .map((asset) => asset.path);

    expect(leaked.length).toBeGreaterThan(0);
    expect(leaked.every((path) => path.endsWith(".html"))).toBe(true);
  }, 600_000);
});
