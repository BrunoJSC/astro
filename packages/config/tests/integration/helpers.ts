import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * The presets, compiled by the compiler.
 *
 * This package is five JSON files and no code, which makes it look untestable
 * and makes it the opposite: a tsconfig preset has no behaviour until `tsc`
 * reads it, and every claim about one -- that `noUnusedLocals` is an error
 * rather than a style preference, that `verbatimModuleSyntax` forces
 * `import type` -- is a claim about what the compiler does.
 *
 * So nothing here parses JSON and reasons about `extends`. It runs the real
 * binary: `--showConfig` for the resolved options, and a real compile of a
 * real fixture for the behaviour.
 */

export const CONFIG = join(import.meta.dir, "../..");
const ROOT = join(CONFIG, "../..");
const TSC = join(ROOT, "node_modules/.bin/tsc");

export const PRESETS = [
  "base",
  "elysia",
  "expo",
  "nextjs",
  "react-library",
] as const;

export type Preset = (typeof PRESETS)[number];

/**
 * Fixtures live INSIDE the package, not in the system temp directory.
 *
 * `elysia.json` sets `types: ["bun"]` and the React presets need
 * `react/jsx-runtime`; TypeScript finds both by walking up from the file to a
 * `node_modules`, and a directory under `/var/folders` has none above it. A
 * fixture there fails with "Cannot find type definition file for 'bun'" --
 * which says nothing about the preset.
 *
 * Namespaced by process id, so two runs of this suite at once -- turbo
 * schedules `test` and `test:integration` as separate tasks -- cannot delete
 * each other's directories. Without it that showed up as TS5058, "the
 * specified path does not exist", pointing at a fixture instead of at the
 * race.
 */
const FIXTURES = join(CONFIG, ".fixtures", String(process.pid));

export interface CompileResult {
  ok: boolean;
  output: string;
}

/** Every diagnostic code the compiler reported, e.g. `TS6133`. */
export function codes(result: CompileResult): string[] {
  return [...result.output.matchAll(/error (TS\d+)/g)].map(
    (match) => match[1] ?? ""
  );
}

async function run(args: string[], cwd: string): Promise<CompileResult> {
  const proc = Bun.spawn([TSC, ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { ok: exitCode === 0, output: `${stdout}\n${stderr}` };
}

/**
 * Compiles `files` against one preset and reports what the compiler said.
 *
 * The fixture directory is thrown away afterwards whether or not the compile
 * succeeded -- a failing case is the normal outcome for half of these tests.
 */
export async function compile(
  preset: Preset,
  files: Record<string, string>,
  options: Record<string, unknown> = {}
): Promise<CompileResult> {
  mkdirSync(FIXTURES, { recursive: true });
  const dir = mkdtempSync(join(FIXTURES, "case-"));

  try {
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { noEmit: true, ...options },
        extends: join(CONFIG, `${preset}.json`),
        include: Object.keys(files),
      })
    );
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents);
    }

    return await run(["--noEmit", "-p", "tsconfig.json"], dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

/** The options a preset resolves to, with `extends` applied by the compiler. */
export async function showConfig(
  preset: Preset
): Promise<Record<string, unknown>> {
  mkdirSync(FIXTURES, { recursive: true });
  const dir = mkdtempSync(join(FIXTURES, "show-"));

  try {
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ extends: join(CONFIG, `${preset}.json`), files: [] })
    );
    const result = await run(["--showConfig", "-p", "tsconfig.json"], dir);
    const start = result.output.indexOf("{");
    if (start < 0) {
      throw new Error(`tsc printed no config for ${preset}:\n${result.output}`);
    }

    const parsed = JSON.parse(result.output.slice(start)) as {
      compilerOptions?: Record<string, unknown>;
    };
    return parsed.compilerOptions ?? {};
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

/** Resolved options for a tsconfig that already exists, by path. */
export async function showConfigAt(
  path: string
): Promise<Record<string, unknown>> {
  const result = await run(["--showConfig", "-p", path], ROOT);
  const start = result.output.indexOf("{");
  if (start < 0) {
    throw new Error(`tsc could not read ${path}:\n${result.output}`);
  }

  const parsed = JSON.parse(result.output.slice(start)) as {
    compilerOptions?: Record<string, unknown>;
  };
  return parsed.compilerOptions ?? {};
}

/**
 * Removes the fixture root, but only once it is empty.
 *
 * Every `compile` and `showConfig` already deletes the directory it made, in a
 * `finally`. This exists to leave nothing behind at the end -- and it checks
 * for emptiness because an earlier version removed the whole tree from one
 * file's `afterAll` while another file still had a compiler running against a
 * directory inside it. That surfaced as TS5058, "the specified path does not
 * exist", reported against the fixture rather than against the race.
 */
export function cleanupFixtures(): void {
  try {
    if (readdirSync(FIXTURES).length === 0) {
      rmSync(FIXTURES, { recursive: true });
    }
  } catch {
    // Already gone, which is the outcome this wanted.
  }
}
