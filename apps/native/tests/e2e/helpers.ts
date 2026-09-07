import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The Expo CLI, driven for real.
 *
 * `expo export` runs Metro over the app and writes the bundle a device would
 * load. It needs no simulator, no Xcode and no Android SDK, which is the whole
 * reason this suite can exist on a machine that has none of them -- what it
 * cannot cover is anything after the bundle: native modules, permissions, the
 * Keychain. Those still need a device.
 *
 * Bytecode is switched off with `--no-bytecode` so the bundle is text. A
 * release build ships Hermes bytecode compiled FROM this exact JavaScript, so
 * module resolution and Metro's inlining -- everything asserted here -- are
 * identical; only the encoding differs.
 *
 * The first export takes about a minute. Metro caches, so the rest take a few
 * seconds, and `bun test` runs the whole suite in one process, so the cached
 * promise below is shared across files.
 */

export const NATIVE = join(import.meta.dir, "../..");

/**
 * Values passed to the CLI, chosen to be findable in the output.
 *
 * The two server-side ones are here precisely because they must NOT appear.
 * `apps/native` depends on `@repo/auth`, so `@repo/env/server` is one import
 * away; passing real-looking values and searching for them is what turns "no
 * one has done that" into something checked.
 */
export const SENTINEL = {
  apiUrl: "http://sentinel-api.invalid",
  databaseUrl: "postgres://sentinel:sentinel@127.0.0.1:5432/sentinel_db",
  secret: "sentinel-server-secret-of-at-least-32-chars",
} as const;

export interface CliResult {
  exitCode: number;
  /** stdout and stderr together, for searching. */
  output: string;
  /** stdout alone, which is where `--json` puts its payload. */
  stdout: string;
}

export interface ExportResult extends CliResult {
  dir: string;
}

/**
 * The child's environment. A `null` override REMOVES the variable.
 *
 * Removal has to be expressible separately from an empty value: the schema
 * treats `""` as unset (`emptyStringAsUndefined`), but the dotenv loader does
 * not -- it leaves an already-present variable alone, empty or not. Setting
 * `""` therefore blocks `.env` from supplying the value, which is the opposite
 * of what a test of the dotenv path wants.
 */
function env(overrides: Record<string, string | null>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      base[key] = value;
    }
  }

  const merged: Record<string, string> = {
    ...base,
    BETTER_AUTH_SECRET: SENTINEL.secret,
    DATABASE_URL: SENTINEL.databaseUrl,
    EXPO_PUBLIC_API_URL: SENTINEL.apiUrl,
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

/**
 * Runs the CLI with both streams captured to files.
 *
 * Files, not pipes, and the difference is not cosmetic. The CLI writes its
 * validation error with `console.error` and then exits; against a pipe those
 * writes are asynchronous and the tail of them is lost, so the message arrives
 * truncated -- "Invalid environment variables" with the offending key gone. A
 * file descriptor is written synchronously and the whole message survives.
 */
async function run(
  args: string[],
  overrides: Record<string, string | null>,
): Promise<CliResult> {
  const logs = mkdtempSync(join(tmpdir(), "repo-native-log-"));
  const outPath = join(logs, "stdout");
  const errPath = join(logs, "stderr");

  const proc = Bun.spawn(["bunx", "expo", ...args], {
    cwd: NATIVE,
    env: env(overrides),
    stderr: Bun.file(errPath),
    stdout: Bun.file(outPath),
  });

  const exitCode = await proc.exited;
  const stdout = readFileSync(outPath, "utf8");
  const stderr = readFileSync(errPath, "utf8");
  rmSync(logs, { force: true, recursive: true });

  return { exitCode, output: [stdout, stderr].join("\n"), stdout };
}

/**
 * Exports to a throwaway directory outside the repository.
 *
 * Deliberately not `apps/native/dist`: a test that leaves 3 MB of build output
 * in the working tree is a test people delete.
 *
 * `clearCache` is what makes an assertion about the bundle's CONTENT mean
 * anything, and it was not obvious. Metro inlines `process.env.EXPO_PUBLIC_*`
 * at transform time and its cache does not key on the value, so a cached
 * module carries whichever URL was current when it was first transformed. Any
 * earlier `expo start` on the machine is enough to make the assertion read a
 * stale value -- measured, twice: once from this suite's own dotenv test, and
 * again under turbo, whose strict env mode drops `TMPDIR` and so lands Metro
 * on a SECOND cache that a direct run never clears.
 *
 * It costs about a minute, which is why only the shared export pays it. The
 * exports that assert an exit code do not care what was inlined.
 */
export async function runExport(
  overrides: Record<string, string | null> = {},
  clearCache = false,
): Promise<ExportResult> {
  const dir = mkdtempSync(join(tmpdir(), "repo-native-export-"));
  const result = await run(
    [
      "export",
      "--platform",
      "ios",
      "--no-bytecode",
      ...(clearCache ? ["--clear"] : []),
      "--output-dir",
      dir,
    ],
    overrides,
  );

  if (result.exitCode !== 0) {
    // A failed export writes nothing, and the env-validation tests run several
    // on purpose; without this each leaves an empty directory behind.
    rmSync(dir, { force: true, recursive: true });
  }

  return { ...result, dir };
}

export function runConfig(
  overrides: Record<string, string | null> = {},
): Promise<CliResult> {
  return run(["config", "--json"], overrides);
}

let exported: Promise<ExportResult> | undefined;
let configured: Promise<CliResult> | undefined;

export function exportOnce(): Promise<ExportResult> {
  exported ??= runExport({}, true);
  return exported;
}

export function configOnce(): Promise<CliResult> {
  configured ??= runConfig();
  return configured;
}

export function cleanupExport(): void {
  exported
    ?.then(({ dir }) => rmSync(dir, { force: true, recursive: true }))
    .catch(() => {
      // Nothing to remove if the export never produced a directory.
    });
}

/** The single JavaScript bundle Metro emitted, as text. */
export function bundle({ dir }: ExportResult): string {
  const base = join(dir, "_expo/static/js/ios");
  const files = readdirSync(base).filter((name) => name.endsWith(".js"));
  if (files.length !== 1) {
    throw new Error(`expected one ios bundle, found ${files.length}`);
  }

  return readFileSync(join(base, files[0] ?? ""), "utf8");
}

export interface Metadata {
  bundler: string;
  fileMetadata: Record<string, { assets: unknown[]; bundle: string }>;
}

export function metadata({ dir }: ExportResult): Metadata {
  return JSON.parse(
    readFileSync(join(dir, "metadata.json"), "utf8"),
  ) as Metadata;
}

/** A source file of the app, for the cross-file invariants. */
export function source(relative: string): string {
  return readFileSync(join(NATIVE, relative), "utf8");
}

/** The parsed `expo config --json` payload. */
export function config(result: CliResult): Record<string, unknown> {
  // From stdout alone: Node prints an ExperimentalWarning about TypeScript
  // stripping to stderr, and merging the two makes the payload unparseable.
  const start = result.stdout.indexOf("{");
  if (start < 0) {
    throw new Error(`no JSON in expo config output:\n${result.output}`);
  }

  return JSON.parse(result.stdout.slice(start)) as Record<string, unknown>;
}
