import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build, ENTRY, emits } from "./tailwind";

/**
 * The stylesheet, compiled.
 *
 * `src/styles/globals.css` is checked by nothing else. Biome cannot even parse
 * it -- `@theme`, `@source` and `@custom-variant` are not CSS, and the file is
 * excluded from linting outright -- so a mistake in it reaches an app's build
 * and nowhere earlier.
 */

/**
 * A mutated copy, written beside the original so `@source "../components"`
 * still resolves the same way. Removed in `afterAll`.
 */
const MUTANT = join(import.meta.dir, "../../src/styles/globals.mutant.css");

describe("compiling globals.css", () => {
  let css: string;

  beforeAll(async () => {
    css = await build();
  });

  it("compiles at all", () => {
    // The baseline nothing else covers. `@import "tailwindcss"` plus
    // `tw-animate-css` plus the `@theme` block either resolve or they do not.
    expect(css.length).toBeGreaterThan(1000);
  });

  it("emits the preflight reset", () => {
    expect(css).toContain("box-sizing");
  });

  it("declares the design tokens as custom properties", () => {
    for (const token of [
      "--background",
      "--foreground",
      "--primary",
      "--primary-foreground",
      "--destructive",
      "--ring",
      "--radius",
    ]) {
      expect(css, `${token} must reach the output`).toContain(token);
    }
  });

  it("keeps colours in oklch rather than hex", () => {
    // The whole palette is oklch so lightness stays perceptually even across
    // the ramp. A hex value creeping in is a token that skipped the system.
    expect(css).toContain("oklch(");
  });

  it("declares a dark palette, not just a light one", () => {
    expect(css).toContain(".dark");
  });
});

describe("the candidates are actually controlled", () => {
  /*
   * The control that makes every other assertion in this file mean something.
   *
   * If the compiler emitted a rule for any class it was handed, `toContain` on
   * a utility name would pass whether or not the theme resolved it. It does
   * not: an unknown utility produces nothing, so a name that DOES appear
   * appears because `globals.css` made it resolvable.
   */
  it("emits nothing for a utility the theme cannot resolve", async () => {
    const css = await build(["bg-not-a-real-token", "text-also-not-real"]);

    expect(emits(css, "bg-not-a-real-token")).toBe(false);
    expect(emits(css, "text-also-not-real")).toBe(false);
  });

  it("emits a rule for one it can", async () => {
    expect(emits(await build(["bg-primary"]), "bg-primary")).toBe(true);
  });
});

describe("the theme is reachable from utilities", () => {
  it("resolves a token-backed utility to the token, not a literal", async () => {
    /*
     * `@theme inline` is what turns `--primary` into the `bg-primary` utility.
     * Without it the custom properties still exist and every component styled
     * with `bg-primary` renders unstyled -- which looks like a missing class,
     * not a missing theme.
     */
    const css = await build(["bg-primary", "text-primary-foreground"]);

    expect(css).toContain(".bg-primary");
    expect(css).toContain("var(--primary)");
    expect(css).toContain(".text-primary-foreground");
  });

  it("resolves the ring utilities the focus styles depend on", async () => {
    const css = await build(["ring-ring/50", "focus-visible:ring-[3px]"]);

    expect(css).toContain("var(--ring)");
  });

  it("compiles the dark variant into a real selector", async () => {
    // `@custom-variant dark (&:is(.dark *))` -- v4 has no `darkMode` config
    // key, so this declaration is the only thing making `dark:` work.
    const css = await build(["dark:bg-background"]);

    expect(css).toContain(".dark");
    expect(css).toContain("var(--background)");
  });
});

describe("@source reaches the components", () => {
  afterAll(() => {
    rmSync(MUTANT, { force: true });
  });

  it("emits the Button's utilities with no candidates supplied", async () => {
    // Compiled with nothing passed in, so this is the directive finding
    // `button.tsx` rather than the test naming its classes.
    const css = await build();

    for (const utility of ["whitespace-nowrap", "shrink-0", "inline-flex"]) {
      expect(emits(css, utility), `${utility} must reach the output`).toBe(
        true,
      );
    }
  });

  it("emits none of them when the directive points elsewhere", async () => {
    /*
     * The mutation, run rather than argued. `@source "../components"` looks
     * redundant next to v4's automatic detection, and under the default `base`
     * it IS -- detection scans the whole repository and finds `button.tsx`
     * either way, which is how an earlier version of this test passed with the
     * directive broken.
     *
     * With detection given nothing to find, the directive is the only path from
     * the stylesheet to the components, and breaking it costs roughly half the
     * output. That is the situation an app is in when its own `@source` list
     * does not happen to cover this package.
     */
    const original = readFileSync(ENTRY, "utf8");
    expect(original).toContain('@source "../components";');
    writeFileSync(
      MUTANT,
      original.replace('@source "../components";', '@source "../nowhere";'),
    );

    const css = await build([], MUTANT);

    /*
     * Asserted on the SELECTOR, not on the text. `display: inline-flex` shows
     * up in preflight regardless, so `toContain("inline-flex")` would be true
     * either way -- which is the same class of mistake this whole file exists
     * to stop.
     */
    for (const utility of ["whitespace-nowrap", "shrink-0", "inline-flex"]) {
      expect(emits(css, utility), `${utility} must be gone`).toBe(false);
    }
  });
});
