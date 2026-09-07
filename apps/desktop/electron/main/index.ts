import { join } from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { registerCredentialHandlers } from "./credentials";

/**
 * The main process.
 *
 * Electron's defaults are safe in current versions, but the things that make an
 * Electron app dangerous are all decisions this file makes: what the renderer
 * is allowed to reach, where it may navigate, and what it may ask the OS to do.
 * Each of those is closed explicitly below rather than left to a default that
 * could change.
 */

/**
 * The API origin, needed for the CSP and for the navigation allowlist.
 *
 * Both sources, in this order, and the second one is the one that matters in
 * production.
 *
 * `import.meta.env` is the syntax Vite substitutes at build time; `process.env`
 * it leaves alone. Reading only `process.env` therefore compiled nothing in,
 * and a packaged app -- launched from Finder or Explorer with no shell
 * environment at all -- fell back to localhost. The CSP is built from this
 * value, so every installed build blocked the real API and the gateway socket,
 * while `bun run dev` inherited the developer's shell and looked correct.
 *
 * `process.env` stays first so a build can still be pointed at staging without
 * rebuilding. Pinned by `tests/e2e/main.test.ts`, which asserts both branches.
 */
const API_URL =
  process.env.VITE_API_URL ??
  import.meta.env.VITE_API_URL ??
  "http://localhost:3001";

/** Where the renderer legitimately lives. Everything else is external. */
const DEV_SERVER = process.env.ELECTRON_RENDERER_URL;

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    center: true,
    height: 800,
    minHeight: 560,
    minWidth: 940,
    /*
     * Created hidden and revealed on `ready-to-show`. A window shown
     * immediately is a white rectangle until the bundle parses -- brief on a
     * fast machine, very visible on a cold start.
     */
    show: false,
    webPreferences: {
      /*
       * The three that matter, spelled out even where they are already the
       * default. `sandbox` puts the renderer in Chromium's OS sandbox;
       * `contextIsolation` keeps the preload's world separate from the page's,
       * so a compromised page cannot rewrite the bridge; `nodeIntegration:
       * false` means `require` does not exist in the page at all.
       *
       * With all three on, the renderer's entire reach into the OS is the
       * handful of methods in `../preload`.
       */
      contextIsolation: true,
      nodeIntegration: false,
      // `.cjs`, not `.js`: a sandboxed preload must be CommonJS, and this
      // package is `"type": "module"`. See electron.vite.config.ts.
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      // Rejects self-signed and expired certificates in `fetch` from the
      // renderer, which is off by default in some Electron templates.
      webSecurity: true,
    },
    width: 1200,
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  /*
   * A link that would open a new window opens in the user's real browser
   * instead. An OAuth provider's sign-in page rendered inside an app window is
   * both blocked by most providers and unable to see an existing session --
   * and a popup with no address bar is where phishing lives.
   */
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });

  /*
   * Navigating away would replace the app with a web page, in a window with no
   * address bar and no way back. Only the renderer's own origin is allowed.
   */
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = DEV_SERVER
      ? url.startsWith(DEV_SERVER)
      : url.startsWith("file://");
    if (!allowed) {
      event.preventDefault();
      openExternal(url);
    }
  });

  if (DEV_SERVER) {
    mainWindow.loadURL(DEV_SERVER);
  } else {
    mainWindow.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/**
 * Hands a URL to the OS browser, after checking it is one.
 *
 * The check is the point. `shell.openExternal` will hand anything to the
 * platform handler, and that includes `file://`, `smb://` and on Windows
 * schemes that execute. A renderer that has been compromised should not be able
 * to turn "open a link" into "run a program".
 */
function openExternal(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }

  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    shell.openExternal(url);
  }
}

/**
 * Content Security Policy, applied to every response the renderer loads.
 *
 * Set here rather than as a `<meta>` tag so one policy covers both the dev
 * server and the packaged `file://` load, and so the API origin comes from the
 * same value the renderer uses instead of being duplicated into HTML.
 */
function applyCsp(): void {
  const api = new URL(API_URL);
  const socket = `${api.protocol === "https:" ? "wss:" : "ws:"}//${api.host}`;

  const policy = [
    "default-src 'self'",
    `connect-src 'self' ${api.origin} ${socket}${DEV_SERVER ? " ws://localhost:*" : ""}`,
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    // Vite injects styles inline, in dev and in the built bundle alike.
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    // No plugins, no framing, and nothing may frame this app.
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

  const { session } = mainWindow?.webContents ?? {};
  session?.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

/*
 * One instance only.
 *
 * A second launch -- from a deep link, or the user clicking the icon again --
 * focuses the window that exists instead of starting a second process that
 * would fight over the credential file and open a second gateway socket.
 */
if (app.requestSingleInstanceLock()) {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // After ready: on Linux `safeStorage` cannot report its backend truthfully
    // before the secret key has resolved.
    registerCredentialHandlers();

    ipcMain.handle("app:version", () => app.getVersion());
    ipcMain.handle("app:open-external", (_event, url: string) =>
      openExternal(url)
    );

    createWindow();
    applyCsp();

    // macOS keeps the process alive with no windows; clicking the dock icon is
    // expected to bring one back.
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  // Everywhere except macOS, closing the last window quits.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
} else {
  app.quit();
}
