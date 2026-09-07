import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, PRESETS, showConfigAt } from "./helpers";

/**
 * The presets against the packages that extend them.
 *
 * A preset nobody can resolve is worse than a missing one: `extends` failing
 * is reported by the compiler as a config error at the top of an otherwise
 * silent run, and the usual reaction is to look at the consuming package.
 */

const ROOT = join(CONFIG, "../..");

/** `"extends": "@repo/config/x.json"` in a file that may contain comments. */
const EXTENDS = /"extends"\s*:\s*"(@repo\/config\/[^"]+)"/;

interface Consumer {
  path: string;
  preset: string;
}

function consumers(): Consumer[] {
  const found: Consumer[] = [];

  for (const group of ["apps", "packages"]) {
    for (const name of readdirSync(join(ROOT, group))) {
      for (const relative of ["tsconfig.json", "tests/tsconfig.json"]) {
        const path = join(ROOT, group, name, relative);
        if (!existsSync(path)) {
          continue;
        }

        const preset = readFileSync(path, "utf8").match(EXTENDS)?.[1];
        if (preset) {
          found.push({ path: `${group}/${name}/${relative}`, preset });
        }
      }
    }
  }

  return found;
}

const ALL = consumers();

interface Manifest {
  exports: Record<string, string>;
  files: string[];
}

const manifest = JSON.parse(
  readFileSync(join(CONFIG, "package.json"), "utf8")
) as Manifest;

describe("the package's own manifest", () => {
  it("exports exactly the presets on disk", () => {
    /*
     * Both directions. A preset missing from `exports` cannot be resolved by
     * anything -- Node's exports map is a closed list, and `moduleResolution:
     * Bundler` honours it. An entry pointing at a file that is not there fails
     * the same way, one step later.
     */
    const onDisk = readdirSync(CONFIG)
      .filter((name) => name.endsWith(".json") && name !== "package.json")
      .sort();

    expect(onDisk).toEqual(PRESETS.map((preset) => `${preset}.json`).sort());
    // The export keys carry the `./` a subpath export needs; the file list
    // does not. Compared in the shape each actually has.
    expect(Object.keys(manifest.exports).sort()).toEqual(
      onDisk.map((name) => `./${name}`)
    );
    // `files` decides what a publish would carry. It is a private package
    // today, and the day it is not is not the day to discover this.
    expect([...manifest.files].sort()).toEqual(onDisk);
  });

  it("points every export at a file that exists", () => {
    for (const [name, target] of Object.entries(manifest.exports)) {
      expect(existsSync(join(CONFIG, target)), `${name} -> ${target}`).toBe(
        true
      );
    }
  });
});

describe("the packages that extend a preset", () => {
  it("finds them, so the assertions below are not vacuous", () => {
    // Nine today. The count is asserted loosely on purpose -- a new package
    // should not have to edit this file -- but zero would mean the scan broke.
    expect(ALL.length).toBeGreaterThanOrEqual(9);
  });

  it("names only presets this package exports", () => {
    for (const { path, preset } of ALL) {
      const name = preset.replace("@repo/config/", "");

      expect(
        manifest.exports[`./${name}`],
        `${path} extends ${preset}, which is not exported`
      ).toBeDefined();
    }
  });

  it("uses a preset that suits what the package is", () => {
    /*
     * Not a style rule. `elysia.json` is the only preset with `types: ["bun"]`
     * and no DOM lib; a server package on a React preset type-checks against
     * `document`, and a React package on `base` cannot compile a `.tsx` at
     * all -- proved in `presets.test.ts`.
     */
    const expected: Record<string, string> = {
      "apps/native/tsconfig.json": "@repo/config/expo.json",
      "apps/server/tsconfig.json": "@repo/config/elysia.json",
      "apps/web/tsconfig.json": "@repo/config/nextjs.json",
      "packages/ui/tsconfig.json": "@repo/config/react-library.json",
    };

    for (const [path, preset] of Object.entries(expected)) {
      const consumer = ALL.find((entry) => entry.path === path);

      expect(consumer?.preset, `${path} should extend ${preset}`).toBe(preset);
    }
  });
});

describe("every consumer's config resolves", () => {
  let outcomes: { options: Record<string, unknown>; path: string }[];

  beforeAll(async () => {
    // Independent reads, so they run together rather than one compiler
    // process at a time.
    outcomes = await Promise.all(
      ALL.map(async ({ path }) => ({
        options: await showConfigAt(join(ROOT, path)),
        path,
      }))
    );
  }, 300_000);

  it("reads through the extends chain, in every one", () => {
    // The compiler doing the resolution, not a regex. A broken `extends` is a
    // config error rather than a type error, and `check-types` reports it in a
    // way that points at the consuming package instead of at this one.
    for (const { options, path } of outcomes) {
      expect(
        Object.keys(options).length,
        `${path} resolved to nothing`
      ).toBeGreaterThan(5);
    }
  });

  it("leaves the inherited strictness on in every package", () => {
    /*
     * The assertion with teeth. A package can override anything in its own
     * tsconfig, and turning `strict` or `noUncheckedIndexedAccess` off locally
     * is a one-line change that nothing else would catch.
     */
    for (const { options, path } of outcomes) {
      for (const option of [
        "strict",
        "noUncheckedIndexedAccess",
        "noUnusedLocals",
        "noUnusedParameters",
        "verbatimModuleSyntax",
        "isolatedModules",
      ]) {
        expect(options[option], `${path} turned ${option} off`).toBe(true);
      }
    }
  });
});
