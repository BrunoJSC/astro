import { beforeAll, describe, expect, it } from "bun:test";
import {
  browserReachable,
  buildOnce,
  prerendered,
  SENTINEL,
  stylesheet,
} from "./helpers";

/**
 * What the build actually hands to a browser.
 *
 * The App Router's Server/Client boundary is a rule about which files run
 * where, and nothing enforces it from the outside. These tests read the
 * emitted output instead of trusting the rule.
 */

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

  it("downlevels the oklch palette, which the source never says", () => {
    /*
     * Measured, and contrary to what reading `packages/ui` suggests.
     *
     * That file's palette is oklch throughout and its own test asserts so. The
     * production stylesheet contains NO `oklch(` at all: each token comes out
     * as a hex value plus a wider-gamut `lab()` behind an `@supports` guard.
     * Both definitions are the same colour and the browser takes whichever it
     * understands.
     *
     * Turbopack's own CSS pipeline does this, not `experimental.optimizeCss` --
     * removing that option leaves the output unchanged, measured. So it happens
     * on every production build here and cannot be configured away by dropping
     * an experiment.
     *
     * Worth pinning in this direction. A future change that made oklch survive
     * to production would drop the fallback with it, and the failure mode is a
     * palette that renders as nothing on an older browser -- unstyled, not
     * merely off-shade.
     */
    const css = stylesheet();

    expect(css).not.toContain("oklch(");
    expect(css).toMatch(/--primary:\s*#[0-9a-f]{3,8}/i);
    expect(css).toContain("lab(");
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
