import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The production build, run once for the whole suite.
 *
 * `next build` is the only thing that exercises what this app actually is: the
 * App Router, the Server/Client boundary, `transpilePackages` compiling five
 * workspace packages from raw TypeScript, Tailwind through Next's own PostCSS
 * pipeline, and the env validation wired into `next.config.ts`. None of it had
 * ever run in a test.
 *
 * Cached in a module-level promise, which works because `bun test` runs every
 * file of a suite in ONE process -- three test files, one build.
 *
 * It writes to `.next`, so it replaces whatever a previous `bun run build` or
 * a running `next dev` left there. Nothing else in the repository reads that
 * directory.
 */

export const WEB = join(import.meta.dir, "../..");
const DIST = join(WEB, ".next");

/**
 * Values supplied to the build, chosen to be findable.
 *
 * Not the developer's own `.env` -- Next does not overwrite a variable that is
 * already set in `process.env`, so these win, and a leak test can then search
 * the output for a string it knows the exact value of. Searching for a real
 * secret would mean putting one in a tracked file; searching for a variable
 * NAME would prove nothing, since the name is not what leaks.
 *
 * That precedence is verified rather than assumed: `aborts on an invalid
 * server variable` in `build.test.ts` passes a too-short secret and the build
 * fails, which it could not do if the `.env` file's valid value had won.
 */
export const SENTINEL = {
  apiUrl: "http://sentinel-api.invalid",
  appUrl: "http://sentinel-app.invalid",
  authUrl: "http://sentinel-auth.invalid",
  databaseUrl: "postgres://sentinel:sentinel@127.0.0.1:5432/sentinel_db",
  secret: "sentinel-server-secret-of-at-least-32-chars",
} as const;

export function buildEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      base[key] = value;
    }
  }

  return {
    ...base,
    BETTER_AUTH_SECRET: SENTINEL.secret,
    BETTER_AUTH_URL: SENTINEL.authUrl,
    DATABASE_URL: SENTINEL.databaseUrl,
    NEXT_PUBLIC_API_URL: SENTINEL.apiUrl,
    NEXT_PUBLIC_APP_URL: SENTINEL.appUrl,
    ...overrides,
  };
}

export interface BuildResult {
  exitCode: number;
  output: string;
}

export async function runBuild(
  overrides: Record<string, string> = {},
): Promise<BuildResult> {
  const proc = Bun.spawn(["bun", "run", "build"], {
    cwd: WEB,
    env: buildEnv(overrides),
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, output: `${stdout}\n${stderr}` };
}

let built: Promise<BuildResult> | undefined;

export function buildOnce(): Promise<BuildResult> {
  built ??= runBuild();
  return built;
}

/**
 * Every built file a browser can end up holding.
 *
 * Both halves matter, and the second one is the half that is easy to forget.
 * `.next/static` is the JavaScript and CSS the browser downloads. The files
 * under `.next/server/app` are the PRERENDERED pages -- `.html` sent verbatim
 * and `.rsc`/`.segments` fetched during navigation -- so a value rendered into
 * a page is just as public as one compiled into a chunk, and it never appears
 * in a JS chunk at all.
 */
export function browserReachable(): { path: string; text: string }[] {
  return [
    ...filesUnder(join(DIST, "static")),
    ...filesUnder(join(DIST, "server", "app")).filter((path) =>
      /\.(html|rsc|segments)$/.test(path),
    ),
  ].map((path) => ({ path: path.slice(DIST.length + 1), text: read(path) }));
}

/** The prerendered HTML of one route, as the browser receives it. */
export function prerendered(route: string): string {
  return read(join(DIST, "server", "app", `${route}.html`));
}

/** The single stylesheet Turbopack emits for the app. */
export function stylesheet(): string {
  const css = filesUnder(join(DIST, "static")).filter((path) =>
    path.endsWith(".css"),
  );
  if (css.length === 0) {
    throw new Error("the build emitted no stylesheet");
  }

  return css.map(read).join("\n");
}

function filesUnder(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return [];
  }

  return entries
    .map((entry) => join(dir, entry))
    .filter((path) => statSync(path).isFile());
}

/** Binary files are read as latin1 so a search never throws on them. */
function read(path: string): string {
  return readFileSync(path, "latin1");
}

/** A port nothing is listening on, released before the caller binds it. */
export async function freePort(): Promise<number> {
  const server = Bun.serve({ fetch: () => new Response("x"), port: 0 });
  const { port } = server;
  await server.stop(true);

  if (port === undefined) {
    throw new Error("Bun.serve bound no port");
  }

  return port;
}
