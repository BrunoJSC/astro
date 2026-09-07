import { beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSchemas, type Schemas } from "./helpers";

/**
 * The schemas against the `.env.example` files that document them.
 *
 * This is the one thing only this package can check. Every app writes its own
 * example file, by hand, and nothing reads them -- they are documentation, and
 * documentation that drifts from a schema is worse than none: it tells someone
 * deploying the app to set a variable that no longer exists, or omits one that
 * aborts the boot.
 */

const ROOT = join(import.meta.dir, "../../../..");

let schemas: Schemas;
/** Declared by this package, in any entry point. */
let DECLARED: Set<string>;

beforeAll(async () => {
  schemas = await loadSchemas();
  DECLARED = new Set(
    Object.values(schemas).flatMap((schema) => Object.keys(schema))
  );
});

/** Read by the apps but never validated here, and deliberately so. */
const UNVALIDATED = new Set([
  // The escape hatch itself; checking it with the schema would be circular.
  "SKIP_ENV_VALIDATION",
  "VITE_SKIP_ENV_VALIDATION",
]);

/** `KEY=value` at the start of a line. Comments start with `#`. */
const ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=(.*)$/;

/** Credentials inside a connection string: `scheme://user:pass@host`. */
const CREDENTIALS = /:\/\/([^@/]+)@/;
/** Words that make a value read as a placeholder rather than a real secret. */
const PLACEHOLDER = /replace|change|example|placeholder|your|generate/i;
/** A host that is unmistakably not a real one. */
const LOCAL_HOST =
  /(localhost|127\.0\.0\.1|\[::1\]|\.invalid|\.example|example\.com)/;

interface Example {
  entries: { key: string; value: string }[];
  path: string;
}

function examples(): Example[] {
  const found: Example[] = [];

  for (const group of ["apps", "packages"]) {
    const dir = join(ROOT, group);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name, ".env.example");
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }

      const entries: { key: string; value: string }[] = [];
      for (const line of text.split("\n")) {
        const match = line.match(ASSIGNMENT);
        if (match?.[1]) {
          entries.push({ key: match[1], value: match[2] ?? "" });
        }
      }
      found.push({ entries, path: `${group}/${name}/.env.example` });
    }
  }

  return found;
}

const ALL = examples();

describe("the example files exist to be checked", () => {
  it("finds one in every package that reads the environment", () => {
    // Without this the whole file passes on an empty list, which is exactly
    // what a moved directory would produce.
    const paths = ALL.map((example) => example.path).sort();

    expect(paths).toEqual([
      "apps/desktop/.env.example",
      "apps/native/.env.example",
      "apps/server/.env.example",
      "apps/web/.env.example",
      "packages/auth/.env.example",
      "packages/db/.env.example",
    ]);
  });
});

describe("every documented variable is a real one", () => {
  it("declares each key in some schema", () => {
    /*
     * The direction that catches a rename. A key documented here and removed
     * from the schema reads as required to whoever is deploying, who sets it,
     * and nothing uses it -- so the real missing variable is still missing and
     * the error names something else.
     */
    for (const example of ALL) {
      for (const { key } of example.entries) {
        expect(
          DECLARED.has(key) || UNVALIDATED.has(key),
          `${example.path} documents ${key}, which no schema declares`
        ).toBe(true);
      }
    }
  });

  it("documents no key twice in one file", () => {
    for (const example of ALL) {
      const keys = example.entries.map((entry) => entry.key);
      expect(new Set(keys).size, `${example.path} repeats a key`).toBe(
        keys.length
      );
    }
  });
});

describe("every required variable is documented", () => {
  /**
   * Required means: no default and not optional. Zod answers this by parsing
   * an empty object -- anything that survives had a default, and anything that
   * fails was required.
   */
  function required(
    schema: Record<string, { safeParse: (v: unknown) => { success: boolean } }>
  ): string[] {
    return Object.entries(schema)
      .filter(([, validator]) => !validator.safeParse(undefined).success)
      .map(([key]) => key);
  }

  it("names the server's required keys wherever the server schema is loaded", () => {
    /*
     * These four packages all evaluate `@repo/env/server` -- the API, the Next
     * app through `next.config.ts`, and both database packages through
     * `drizzle.config.ts`. A missing one aborts the process at import, before
     * anything logs, so the example file is the only warning anyone gets.
     */
    const keys = required(schemas.server);
    expect(keys.length).toBeGreaterThan(0);

    for (const path of [
      "apps/server/.env.example",
      "apps/web/.env.example",
      "packages/auth/.env.example",
      "packages/db/.env.example",
    ]) {
      const example = ALL.find((entry) => entry.path === path);
      const documented = new Set(example?.entries.map((entry) => entry.key));

      for (const key of keys) {
        expect(documented.has(key), `${path} must document ${key}`).toBe(true);
      }
    }
  });

  it("names each client app's own required key", () => {
    const cases: [string, string[]][] = [
      ["apps/web/.env.example", required(schemas.client)],
      ["apps/native/.env.example", required(schemas.native)],
      ["apps/desktop/.env.example", required(schemas.desktop)],
    ];

    for (const [path, keys] of cases) {
      const example = ALL.find((entry) => entry.path === path);
      const documented = new Set(example?.entries.map((entry) => entry.key));

      expect(keys.length, `${path} has nothing required`).toBeGreaterThan(0);
      for (const key of keys) {
        expect(documented.has(key), `${path} must document ${key}`).toBe(true);
      }
    }
  });

  it("keeps each app's public prefix out of the others' files", () => {
    /*
     * `NEXT_PUBLIC_*` in the Expo app's example is a variable Metro will never
     * inline, and vice versa. It reads as configuration and does nothing.
     */
    const wrong: [string, string][] = [
      ["apps/native/.env.example", "NEXT_PUBLIC_"],
      ["apps/desktop/.env.example", "NEXT_PUBLIC_"],
      ["apps/web/.env.example", "EXPO_PUBLIC_"],
      ["apps/server/.env.example", "VITE_"],
    ];

    for (const [path, prefix] of wrong) {
      const example = ALL.find((entry) => entry.path === path);
      const offending = (example?.entries ?? [])
        .map((entry) => entry.key)
        .filter((key) => key.startsWith(prefix));

      expect(offending, `${path} should not carry ${prefix}*`).toEqual([]);
    }
  });
});

describe("the example files carry placeholders, never secrets", () => {
  /*
   * This has already happened here. A gitignored `apps/server/.env` holding two
   * live Neon connection strings was found during a pre-push scan; the example
   * files are the tracked ones, and they are one careless copy away from the
   * same thing.
   */
  it("points every URL at a local or reserved host", () => {
    for (const example of ALL) {
      for (const { key, value } of example.entries) {
        if (!value.includes("://")) {
          continue;
        }
        expect(
          LOCAL_HOST.test(value),
          `${example.path}: ${key} points at a real host`
        ).toBe(true);
      }
    }
  });

  it("carries no credentials in a connection string", () => {
    // `postgres://user:password@host/db` -- the password is the part that
    // matters, and a placeholder should not have one that looks generated.
    for (const example of ALL) {
      for (const { key, value } of example.entries) {
        const credentials = value.match(CREDENTIALS)?.[1] ?? "";
        const password = credentials.split(":")[1] ?? "";

        expect(
          password.length < 20,
          `${example.path}: ${key} looks like it carries a real password`
        ).toBe(true);
      }
    }
  });

  it("does not ship a secret that would actually pass validation", () => {
    /*
     * `BETTER_AUTH_SECRET` needs 32 characters, so an example file has to show
     * something that long -- which is exactly the shape a real one has. It must
     * therefore say what it is, in words, rather than being a plausible
     * random string.
     */
    for (const example of ALL) {
      const secret = example.entries.find(
        (entry) => entry.key === "BETTER_AUTH_SECRET"
      );
      if (!secret) {
        continue;
      }

      expect(
        PLACEHOLDER.test(secret.value),
        `${example.path}: BETTER_AUTH_SECRET must read as a placeholder`
      ).toBe(true);
    }
  });
});
