import { afterAll, describe, expect, it } from "bun:test";
import { cleanupFixtures, codes, compile } from "./helpers";

/**
 * What `base.json` actually refuses.
 *
 * Every option in that file is a claim about the compiler's behaviour, and a
 * claim in a JSON file is worth nothing until something compiles against it.
 * These are real compiles of real fixtures, and the diagnostic codes were
 * measured rather than remembered.
 *
 * All of them use `base.json`, because that is where the strictness lives --
 * the other four presets change `lib`, `jsx` and emit, and inherit this whole
 * set. `presets.test.ts` proves the inheritance.
 */

afterAll(() => {
  cleanupFixtures();
});

describe("strict", () => {
  it("refuses an implicitly-any parameter", async () => {
    const result = await compile("base", {
      "a.ts": "export function f(x) { return x; }\n",
    });

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("TS7006");
  });

  it("refuses null where a string is declared", async () => {
    // strictNullChecks. Without it, `null` is assignable to everything and
    // half of what TypeScript is for stops applying.
    const result = await compile("base", {
      "a.ts": "export const s: string = null;\n",
    });

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("TS2322");
  });
});

describe("noUncheckedIndexedAccess", () => {
  it("makes an indexed read possibly undefined", async () => {
    /*
     * The option that changes the most code, and the one most likely to be
     * turned off in a hurry. `xs[0]` on an empty array is `undefined` at
     * runtime whatever the type says; without this, the type says `string` and
     * the crash happens three frames away from the read.
     */
    const result = await compile("base", {
      "a.ts": "const xs: string[] = [];\nexport const s: string = xs[0];\n",
    });

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("TS2322");
  });

  it("accepts the read once it is narrowed", async () => {
    const result = await compile("base", {
      "a.ts":
        "const xs: string[] = [];\nexport const s: string = xs[0] ?? '';\n",
    });

    expect(result.ok).toBe(true);
  });
});

describe("noUnusedLocals and noUnusedParameters", () => {
  it("makes dead code a compile error, not a lint warning", async () => {
    /*
     * Worth pinning because it reads as a style rule and is not one: it fails
     * `check-types`, which fails the pre-commit hook. Nothing has to be
     * configured in Biome for dead code to be caught.
     */
    const unusedLocal = await compile("base", {
      "a.ts": "export function f() { const x = 1; return 2; }\n",
    });
    const unusedParameter = await compile("base", {
      "a.ts": "export function f(a: number, b: number) { return a; }\n",
    });

    expect(unusedLocal.ok).toBe(false);
    expect(codes(unusedLocal)).toContain("TS6133");
    expect(unusedParameter.ok).toBe(false);
    expect(codes(unusedParameter)).toContain("TS6133");
  });

  it("accepts a parameter deliberately marked unused", async () => {
    // The documented escape hatch: prefix with `_`. If this stopped working,
    // every callback that ignores an argument would need a suppression.
    const result = await compile("base", {
      "a.ts": "export function f(a: number, _b: number) { return a; }\n",
    });

    expect(result.ok).toBe(true);
  });
});

describe("verbatimModuleSyntax", () => {
  it("refuses a value import used only as a type", async () => {
    /*
     * This is what makes `packages/env/src/index.ts` emit no runtime import at
     * all. Under `verbatimModuleSyntax` an `import { T }` is EMITTED, so a
     * types-only barrel written that way would execute the module it re-exports
     * from -- which for that file means running a schema in a client bundle.
     */
    const result = await compile("base", {
      "a.ts": "import { T } from './t.ts';\nexport const v: T = { a: 1 };\n",
      "t.ts": "export type T = { a: number };\n",
    });

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("TS1484");
  });

  it("accepts it written as import type", async () => {
    const result = await compile("base", {
      "a.ts":
        "import type { T } from './t.ts';\nexport const v: T = { a: 1 };\n",
      "t.ts": "export type T = { a: number };\n",
    });

    expect(result.ok).toBe(true);
  });
});

describe("isolatedModules", () => {
  it("refuses re-exporting a type without the type keyword", async () => {
    // Each file has to be transpilable alone, because that is how Bun, esbuild
    // and SWC compile them -- none of them has the type information to know
    // that this export can be erased.
    const result = await compile("base", {
      "a.ts": "export { T } from './t.ts';\n",
      "t.ts": "export type T = { a: number };\n",
    });

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("TS1205");
  });
});

describe("noImplicitOverride", () => {
  it("refuses an override that does not say so", async () => {
    // Silently overriding a base method is how a rename in the base class
    // stops taking effect in the subclass without anything failing.
    const result = await compile("base", {
      "a.ts":
        "export class A { m() { return 1; } }\nexport class B extends A { m() { return 2; } }\n",
    });

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("TS4114");
  });
});

describe("the resolution options the workspace depends on", () => {
  it("allows importing a .ts extension", async () => {
    /*
     * `allowImportingTsExtensions`, and it is load-bearing rather than a
     * convenience: the workspace packages point their `exports` straight at
     * `src/*.ts` with no build step, and `@repo/env/src/shared.ts` is imported
     * with its extension.
     */
    const result = await compile("base", {
      "a.ts": "import { b } from './b.ts';\nexport const c = b;\n",
      "b.ts": "export const b = 1;\n",
    });

    expect(result.ok).toBe(true);
  });

  it("allows importing JSON", async () => {
    // `resolveJsonModule`. `apps/native` reads app.json this way, and
    // drizzle's meta files are JSON.
    const result = await compile("base", {
      "a.ts": "import d from './d.json';\nexport const k = d.k;\n",
      "d.json": '{ "k": 1 }\n',
    });

    expect(result.ok).toBe(true);
  });
});
