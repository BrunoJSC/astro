import { beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BuildResult,
  buildOnce,
  DESKTOP,
  readMain,
  rendererFiles,
  SENTINEL,
} from "./helpers";

/**
 * What `electron-vite build` emits.
 *
 * Three bundles with three different rules -- the main process is Node, the
 * preload is sandboxed CommonJS, the renderer is Chromium -- and getting any
 * of them wrong produces an app that builds cleanly and misbehaves only once
 * installed. Two of the assertions below are regressions this app already had.
 */

/** A minified bundle has few, enormous lines. Source has the opposite. */
const MINIFIED_LINE_LENGTH = 5000;

/** Everything Vite emits for the renderer is content-hashed. */
const HASHED_ASSET = /^index-[A-Za-z0-9_-]{8}\.(js|css)$/;

/** `./assets/...`, never `/assets/...`. See the file:// test below. */
const ABSOLUTE_ASSET = /(src|href)="\/[^/]/;
const RELATIVE_ASSET = /(src|href)="\.\/assets\//;
/** Bare specifiers the main bundle imports, for the externalisation check. */
const BARE_IMPORT = /from ?"([^"]+)"/g;

describe("the build itself", () => {
  let build: BuildResult;

  beforeAll(async () => {
    build = await buildOnce();
  }, 300_000);

  it("succeeds", () => {
    expect(build.exitCode).toBe(0);
  });

  it("emits one bundle per process, with the preload named .cjs", () => {
    /*
     * The filename is pinned in `electron.vite.config.ts` and it has to be.
     * A SANDBOXED preload cannot be an ES module, and this package is
     * `"type": "module"`, so the default output was `index.mjs` -- which a
     * sandboxed renderer fails to load SILENTLY. No bridge, no error, and the
     * app falls back to in-memory credentials, signing the user out on every
     * restart with nothing anywhere saying why.
     *
     * `preload.test.ts` checks the format; this checks the name. Both matter:
     * Electron decides how to load the file from its extension.
     */
    expect(readdirSync(join(DESKTOP, "out/main"))).toEqual(["index.js"]);
    // Exactly one file, and its extension is the whole point: Electron decides
    // how to load a preload from the extension, and `.mjs` is unloadable in a
    // sandbox. An `index.js` here would be read as ESM too -- the package is
    // `"type": "module"` -- so the assertion is on the exact name.
    expect(readdirSync(join(DESKTOP, "out/preload"))).toEqual(["index.cjs"]);
  });
});

describe("the renderer bundle", () => {
  let files: { name: string; text: string }[];

  beforeAll(async () => {
    await buildOnce();
    files = rendererFiles();
  }, 300_000);

  it("is minified", () => {
    /*
     * electron-vite leaves the renderer UNMINIFIED by default, unlike plain
     * Vite, and nothing in the build output says so. Measured on this app when
     * it was found: 1,566 kB against 669 kB, shipped inside the installer and
     * sitting on the user's disk.
     *
     * Asserted on line length rather than on bytes alone -- a bundle that grew
     * legitimately should not fail this, and an unminified one cannot pass it.
     */
    const scripts = files.filter((file) => file.name.endsWith(".js"));
    expect(scripts.length).toBeGreaterThan(0);

    for (const script of scripts) {
      const longest = Math.max(
        ...script.text.split("\n").map((line) => line.length)
      );
      expect(longest, `${script.name} must be minified`).toBeGreaterThan(
        MINIFIED_LINE_LENGTH
      );
    }
  });

  it("carries the API origin the build was given", () => {
    // `envPrefix: "VITE_"`. The renderer calls this host and opens the gateway
    // socket to it; there is no environment to read on a user's machine.
    const found = files.filter((file) => file.text.includes(SENTINEL.apiUrl));

    expect(found.length).toBeGreaterThan(0);
  });

  it("carries no server-side value", () => {
    /*
     * Both sentinels were in the environment during the build, so their
     * absence is evidence rather than a vacuous pass. `@repo/auth` is one
     * import away from this renderer, and a bundle is not somewhere a secret
     * can be taken back from -- it ships inside the installer.
     */
    for (const secret of [SENTINEL.secret, SENTINEL.databaseUrl]) {
      const leaked = files
        .filter((file) => file.text.includes(secret))
        .map((file) => file.name);

      expect(leaked, `${secret.slice(0, 12)}... must not ship`).toEqual([]);
    }
  });

  it("pulls in none of the server's Node-only dependencies", () => {
    // Reaching `@repo/auth/server` instead of `@repo/auth/client` drags
    // argon2's native addon and the Postgres driver into Chromium, where
    // neither can load.
    for (const marker of ["argon2", "drizzle-orm", "pg-connection-string"]) {
      const found = files
        .filter((file) => file.text.includes(marker))
        .map((file) => file.name);

      expect(found, `${marker} must stay on the server`).toEqual([]);
    }
  });
});

describe("the design system reaches the packaged CSS", () => {
  let css: string;

  beforeAll(async () => {
    await buildOnce();
    css = rendererFiles()
      .filter((file) => file.name.endsWith(".css"))
      .map((file) => file.text)
      .join("\n");
  }, 300_000);

  it("emits a stylesheet with the tokens", () => {
    // `@repo/ui/styles` through Vite's PostCSS: `@theme inline` becomes real
    // custom properties, or every component renders unstyled.
    expect(css).toContain("--primary");
    expect(css).toContain("--background");
    expect(css.length).toBeGreaterThan(1000);
  });

  it("keeps the palette in oklch, unlike the web build", () => {
    /*
     * The one place this app gets something the web app cannot have.
     *
     * `apps/web` ships hex plus a `lab()` fallback because its output has to
     * survive whatever browser a visitor brings. Here Chromium is bundled and
     * its version is known, so the wide-gamut values reach the screen as
     * written. If this ever starts downlevelling, the renderer target changed.
     */
    expect(css).toContain("oklch(");
  });
});

describe("the packaged document", () => {
  let html: string;

  beforeAll(async () => {
    await buildOnce();
    html = readFileSync(join(DESKTOP, "out/renderer/index.html"), "utf8");
  }, 300_000);

  it("references built assets rather than the source entry", () => {
    // `<script src="/src/main.tsx">` is the dev-server document. Shipping it
    // gives a blank window with a 404 in a console nobody opens.
    expect(html).not.toContain("/src/main.tsx");
    expect(html).toContain("assets/index-");
  });

  it("references them by RELATIVE path, which file:// requires", () => {
    /*
     * The packaged renderer is loaded with `loadFile`, so the document's
     * origin is `file://`. An absolute `/assets/...` then resolves to the
     * filesystem ROOT, not to the app bundle, and the window comes up blank.
     * Development never shows it: a dev server serves `/assets/...` happily.
     *
     * electron-vite is what guarantees this today -- setting `base: "/"` in
     * the renderer config is overridden and still emits `./assets/`, measured.
     * The assertion is on the output for that reason: it survives whoever
     * builds the renderer, and it is the packaged app's blank-window bug.
     */
    expect(html).toMatch(RELATIVE_ASSET);
    expect(html).not.toMatch(ABSOLUTE_ASSET);
  });

  it("names every asset with a content hash", () => {
    // Cache-busting matters here for the auto-updater: a renderer file whose
    // name never changes can be served from a stale cache after an update.
    const names = rendererFiles().map((file) => file.name);

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name, `${name} must be content-hashed`).toMatch(HASHED_ASSET);
    }
  });
});

describe("the main bundle", () => {
  beforeAll(async () => {
    await buildOnce();
  }, 300_000);

  it("reaches nothing but electron and Node's own builtins", () => {
    /*
     * `externalizeDepsPlugin` keeps node_modules out of the main bundle: it
     * runs in Node, so bundling dependencies is pure cost, and it breaks any
     * package with a native binding -- which is how this usually shows up.
     *
     * A bare specifier appearing here that is neither would mean a dependency
     * was inlined, or that the main process started importing from the
     * renderer's half of the app.
     */
    const specifiers = [...readMain().matchAll(BARE_IMPORT)]
      .map((match) => match[1] ?? "")
      .filter((name) => !name.startsWith("."));

    for (const specifier of new Set(specifiers)) {
      expect(
        specifier === "electron" || specifier.startsWith("node:"),
        `${specifier} must not be bundled into the main process`
      ).toBe(true);
    }
  });

  it("is not minified, because it is read when something crashes", () => {
    // The opposite decision from the renderer, and deliberate: the main
    // bundle is small, never downloaded, and its stack traces are the only
    // thing a crash report carries.
    const longest = Math.max(
      ...readMain()
        .split("\n")
        .map((line) => line.length)
    );

    expect(longest).toBeLessThan(MINIFIED_LINE_LENGTH);
  });
});
