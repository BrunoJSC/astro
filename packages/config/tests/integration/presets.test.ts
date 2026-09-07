import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  cleanupFixtures,
  compile,
  PRESETS,
  type Preset,
  showConfig,
} from "./helpers";

/**
 * The four derived presets, resolved by the compiler rather than by reading
 * `extends` and merging the JSON by hand.
 *
 * The distinction matters: `extends` has rules -- relative paths resolve
 * against the file that declares them, arrays replace rather than merge -- and
 * reimplementing them here would test the reimplementation.
 */

/** Everything `base.json` turns on and every derived preset must keep. */
const INHERITED_STRICTNESS = [
  "allowImportingTsExtensions",
  "esModuleInterop",
  "forceConsistentCasingInFileNames",
  "isolatedModules",
  "noImplicitOverride",
  "noUncheckedIndexedAccess",
  "noUnusedLocals",
  "noUnusedParameters",
  "resolveJsonModule",
  "skipLibCheck",
  "strict",
  "verbatimModuleSyntax",
] as const;

const resolved = new Map<Preset, Record<string, unknown>>();

beforeAll(async () => {
  // In parallel: five independent `tsc --showConfig` processes, each in its
  // own fixture directory.
  const all = await Promise.all(
    PRESETS.map(async (preset) => [preset, await showConfig(preset)] as const)
  );
  for (const [preset, options] of all) {
    resolved.set(preset, options);
  }
}, 300_000);

afterAll(() => {
  cleanupFixtures();
});

describe("every preset resolves", () => {
  it("covers the five the package exports", () => {
    // If a preset is added and this list is not, the new one has no test at
    // all -- which is the state this package was in.
    expect([...PRESETS]).toEqual([
      "base",
      "elysia",
      "expo",
      "nextjs",
      "react-library",
    ]);
    expect(resolved.size).toBe(5);
  });

  it("gives each one a non-empty option set", () => {
    for (const preset of PRESETS) {
      expect(Object.keys(resolved.get(preset) ?? {}).length).toBeGreaterThan(5);
    }
  });
});

describe("base.json", () => {
  it("turns on every strictness option the repository relies on", () => {
    const base = resolved.get("base") ?? {};

    for (const option of INHERITED_STRICTNESS) {
      expect(base[option], `${option} must be on in base`).toBe(true);
    }
  });

  it("targets ES2022 with bundler resolution", () => {
    // `Bundler` is what lets the workspace packages be imported through their
    // `exports` field with no build step.
    const base = resolved.get("base") ?? {};

    expect(base.target).toBe("es2022");
    expect(base.moduleResolution).toBe("bundler");
    expect(base.moduleDetection).toBe("force");
  });

  it("emits declarations, which the derived presets switch off", () => {
    // The default suits a library; an app compiles with `noEmit` and does not
    // want the extra output. Asserted here so the override below means
    // something.
    expect(resolved.get("base")?.declaration).toBe(true);
  });
});

describe("the derived presets keep what they extend", () => {
  it("inherits every strictness option, in all four", () => {
    /*
     * The regression this catches is a preset that redeclares
     * `compilerOptions` in a way that drops the chain -- easy to do, invisible
     * in review, and it silently relaxes a whole app.
     */
    for (const preset of [
      "elysia",
      "expo",
      "nextjs",
      "react-library",
    ] as const) {
      const options = resolved.get(preset) ?? {};

      for (const option of INHERITED_STRICTNESS) {
        expect(options[option], `${preset} must inherit ${option}`).toBe(true);
      }
    }
  });
});

describe("each preset overrides only what it should", () => {
  it("elysia targets ESNext, types Bun, and emits nothing", () => {
    const elysia = resolved.get("elysia") ?? {};

    expect(elysia.target).toBe("esnext");
    expect(elysia.types).toEqual(["bun"]);
    expect(elysia.noEmit).toBe(true);
    // Declarations are off wherever nothing is emitted; leaving them on makes
    // the compiler do work whose output is discarded.
    expect(elysia.declaration).toBe(false);
    expect(elysia.declarationMap).toBe(false);
  });

  it("nextjs preserves JSX for the framework to compile", () => {
    /*
     * `preserve`, not `react-jsx`. Next runs its own transform -- with the
     * Server/Client boundary and the compiler it applies -- so TypeScript has
     * to hand the JSX through untouched.
     */
    const nextjs = resolved.get("nextjs") ?? {};

    expect(nextjs.jsx).toBe("preserve");
    expect(nextjs.noEmit).toBe(true);
    expect(nextjs.module).toBe("esnext");
  });

  it("the React presets compile JSX themselves", () => {
    // `react-jsx`: no `import React` needed, and TypeScript emits the runtime
    // call itself because nothing downstream will.
    expect(resolved.get("react-library")?.jsx).toBe("react-jsx");
    expect(resolved.get("expo")?.jsx).toBe("react-jsx");
  });

  it("gives the browser presets a DOM lib and leaves it off elsewhere", () => {
    /*
     * The one that catches a real mistake: `document` type-checking in the API
     * means server code can reference a global that does not exist at runtime.
     */
    const dom = (preset: Preset) =>
      ((resolved.get(preset)?.lib ?? []) as string[]).some((entry) =>
        entry.toLowerCase().startsWith("dom")
      );

    expect(dom("react-library")).toBe(true);
    expect(dom("nextjs")).toBe(true);
    expect(dom("expo")).toBe(true);
    expect(dom("base")).toBe(false);
    expect(dom("elysia")).toBe(false);
  });
});

describe("the presets do what their options say", () => {
  it("compiles Bun's globals under elysia and not under base", async () => {
    /*
     * `types: ["bun"]`, exercised rather than read. The API is written against
     * `Bun.serve`, and a preset that lost this line would fail every server
     * file with "Cannot find name 'Bun'".
     */
    const underElysia = await compile("elysia", {
      "a.ts": "export const version = Bun.version;\n",
    });
    const underBase = await compile("base", {
      "a.ts": "export const version = Bun.version;\n",
    });

    expect(underElysia.ok).toBe(true);
    expect(underBase.ok).toBe(false);
  }, 300_000);

  it("compiles a component under react-library without importing React", async () => {
    // `jsx: react-jsx` end to end: the automatic runtime, no React in scope.
    const result = await compile("react-library", {
      "a.tsx":
        'export function A() {\n  return <div className="x">hi</div>;\n}\n',
    });

    expect(result.ok).toBe(true);
  }, 300_000);

  it("refuses the same component under base, which has no jsx setting", async () => {
    const result = await compile("base", {
      "a.tsx":
        'export function A() {\n  return <div className="x">hi</div>;\n}\n',
    });

    expect(result.ok).toBe(false);
  }, 300_000);
});
