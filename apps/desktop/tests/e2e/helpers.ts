import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The three bundles electron-vite produces, built and then executed.
 *
 * Electron cannot be launched on this machine -- Electron 44 needs macOS 13+
 * and this is 12 -- so nothing here opens a window. It does something better
 * than reading the source, though: the main and preload bundles are RUN, with
 * the `electron` module replaced by a fake, so what this suite observes is the
 * arguments the shipped code actually passes to Electron rather than the text
 * it was written with.
 *
 * What that cannot cover: anything Electron itself does with those arguments.
 * `sandbox: true` is asserted as a value handed to `BrowserWindow`, not as a
 * sandbox that started.
 */

export const DESKTOP = join(import.meta.dir, "../..");
const OUT = join(DESKTOP, "out");

/**
 * Values passed to the build, chosen to be findable in the output.
 *
 * `VITE_API_URL` must appear -- the renderer needs it. The other two must not:
 * they are server-side, and `@repo/auth` is one import away from this app.
 */
export const SENTINEL = {
  apiUrl: "http://sentinel-api.invalid",
  databaseUrl: "postgres://sentinel:sentinel@127.0.0.1:5432/sentinel_db",
  secret: "sentinel-server-secret-of-at-least-32-chars",
} as const;

export interface BuildResult {
  exitCode: number;
  output: string;
}

let built: Promise<BuildResult> | undefined;

export function buildOnce(): Promise<BuildResult> {
  built ??= runBuild();
  return built;
}

async function runBuild(): Promise<BuildResult> {
  const proc = Bun.spawn(["bun", "run", "build"], {
    cwd: DESKTOP,
    env: {
      ...(process.env as Record<string, string>),
      BETTER_AUTH_SECRET: SENTINEL.secret,
      DATABASE_URL: SENTINEL.databaseUrl,
      VITE_API_URL: SENTINEL.apiUrl,
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, output: [stdout, stderr].join("\n") };
}

export function readMain(): string {
  return readFileSync(join(OUT, "main/index.js"), "utf8");
}

export function readPreload(): string {
  return readFileSync(join(OUT, "preload/index.cjs"), "utf8");
}

/** Every file the packaged renderer is made of. */
export function rendererFiles(): { name: string; text: string }[] {
  const dir = join(OUT, "renderer/assets");
  return readdirSync(dir).map((name) => ({
    name,
    text: readFileSync(join(dir, name), "latin1"),
  }));
}

/* ------------------------------------------------------------------ */
/* Running the bundles against a fake Electron                         */
/* ------------------------------------------------------------------ */

export interface Recorder {
  /** `app.on` listeners, by event. */
  appEvents: Record<string, (...args: unknown[]) => unknown>;
  /** `ipcMain.handle` registrations, by channel. */
  channels: Record<string, (...args: unknown[]) => unknown>;
  /** `webContents.on` listeners, by event. */
  contentsEvents: Record<string, (...args: unknown[]) => unknown>;
  /** The callback given to `session.webRequest.onHeadersReceived`. */
  headers?: (
    details: { responseHeaders: Record<string, string[]> },
    done: (result: { responseHeaders: Record<string, string[]> }) => void
  ) => void;
  /** What `requestSingleInstanceLock` should answer. */
  lock: boolean;
  /** URLs handed to `shell.openExternal`. */
  opened: string[];
  /** Whatever `setWindowOpenHandler` was given. */
  openHandler?: (details: { url: string }) => { action: string };
  /** The options object passed to `new BrowserWindow`. */
  options?: { webPreferences?: Record<string, unknown> };
  quit: number;
  /** Method names called on the window, in order. */
  windowCalls: string[];
}

declare global {
  // eslint-disable-next-line no-var
  var __electronStub: Recorder | undefined;
}

export function newRecorder(lock = true): Recorder {
  return {
    appEvents: {},
    channels: {},
    contentsEvents: {},
    lock,
    opened: [],
    quit: 0,
    windowCalls: [],
  };
}

const STUB = `
const rec = () => globalThis.__electronStub;
const win = {
  focus: () => rec().windowCalls.push("focus"),
  isMinimized: () => true,
  loadFile: (p) => rec().windowCalls.push("loadFile:" + p),
  loadURL: (u) => rec().windowCalls.push("loadURL:" + u),
  on: (e, f) => { if (e === "closed") { rec().windowCalls.push("on:closed"); } },
  once: (e, f) => { rec().windowCalls.push("once:" + e); if (e === "ready-to-show") { f(); } },
  restore: () => rec().windowCalls.push("restore"),
  show: () => rec().windowCalls.push("show"),
  webContents: {
    on: (e, f) => { rec().contentsEvents[e] = f; },
    session: { webRequest: { onHeadersReceived: (f) => { rec().headers = f; } } },
    setWindowOpenHandler: (f) => { rec().openHandler = f; },
  },
};
export const app = {
  getPath: () => "/tmp/astro-test-userdata",
  getVersion: () => "9.9.9",
  on: (e, f) => { rec().appEvents[e] = f; },
  quit: () => { rec().quit += 1; },
  requestSingleInstanceLock: () => rec().lock,
  whenReady: () => Promise.resolve(),
};
export function BrowserWindow(options) { rec().options = options; return win; }
BrowserWindow.getAllWindows = () => [win];
export const ipcMain = { handle: (c, f) => { rec().channels[c] = f; } };
export const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "gnome_libsecret",
  encryptString: (s) => Buffer.from("enc:" + s),
  decryptString: (b) => String(b).replace(/^enc:/, ""),
};
export const shell = { openExternal: (u) => { rec().opened.push(u); } };
export default { app, BrowserWindow, ipcMain, safeStorage, shell };
`;

let harness: string | undefined;

/**
 * Loads the BUILT main bundle with `electron` swapped for the stub above.
 *
 * The swap is a text substitution on the emitted file rather than a module
 * mock. `mock.module("electron", ...)` does not intercept it: Bun resolves the
 * bare specifier to the real `electron/index.js`, which is a CommonJS shim that
 * exports nothing outside an Electron process, and the import fails before any
 * mock is consulted.
 *
 * The rewritten copy is written NEXT TO the original because the code resolves
 * `../preload/index.cjs` and `../renderer/index.html` from `import.meta.dirname`
 * -- moving it elsewhere would change what those assertions see.
 */
export async function loadMain(recorder: Recorder): Promise<void> {
  globalThis.__electronStub = recorder;

  if (!harness) {
    writeFileSync(join(OUT, "main/__electron-stub.mjs"), STUB);
    harness = join(OUT, "main/__harness.mjs");
    writeFileSync(
      harness,
      readMain().replaceAll('"electron"', '"./__electron-stub.mjs"')
    );
  }

  // A fresh module instance per call: the bundle runs its work at import time,
  // so a cached one would replay nothing and every test after the first would
  // assert against the first test's recorder.
  counter += 1;
  await import(`${harness}?run=${counter}`);
  await Bun.sleep(10);
}

let counter = 0;

export function cleanupHarness(): void {
  rmSync(join(OUT, "main/__harness.mjs"), { force: true });
  rmSync(join(OUT, "main/__electron-stub.mjs"), { force: true });
  harness = undefined;
}

/**
 * Runs the BUILT preload and returns what it exposed on the main world.
 *
 * CommonJS, so it needs no rewriting -- a function wrapper with a fake
 * `require` is enough, which is exactly how Node loads it.
 */
export function loadPreload(): {
  exposed: Record<string, unknown>;
  invocations: { args: unknown[]; channel: string }[];
} {
  const invocations: { args: unknown[]; channel: string }[] = [];
  const exposed: Record<string, unknown> = {};

  const electron = {
    contextBridge: {
      exposeInMainWorld: (key: string, value: unknown) => {
        exposed[key] = value;
      },
    },
    ipcRenderer: {
      invoke: (channel: string, ...args: unknown[]) => {
        invocations.push({ args, channel });
        return Promise.resolve(null);
      },
    },
  };

  const module = { exports: {} };
  new Function("require", "module", "exports", readPreload())(
    () => electron,
    module,
    module.exports
  );

  return { exposed, invocations };
}

/** A throwaway directory, for the tests that need a path. */
export function scratch(): string {
  return mkdtempSync(join(tmpdir(), "repo-desktop-"));
}
