import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  buildOnce,
  cleanupHarness,
  loadMain,
  newRecorder,
  type Recorder,
  SENTINEL,
} from "./helpers";

/**
 * The main process, executed.
 *
 * Every decision that makes an Electron app safe or unsafe is made in this
 * file: what the renderer may reach, where it may navigate, what it may ask
 * the OS to do. Grepping the bundle for `sandbox: true` proves the string is
 * present; running it proves the value reaches `BrowserWindow`.
 */

afterAll(() => {
  cleanupHarness();
});

describe("the window the renderer gets", () => {
  let recorder: Recorder;

  beforeAll(async () => {
    await buildOnce();
    recorder = newRecorder();
    await loadMain(recorder);
    // The window is created inside `app.whenReady()`, one microtask later.
    await Bun.sleep(20);
  }, 300_000);

  it("creates a window at all", () => {
    expect(recorder.options).toBeDefined();
  });

  it("closes the three settings that decide what the page can reach", () => {
    /*
     * Asserted as the object handed to Electron, not as source text. Each of
     * these is already the default in current Electron; they are spelled out
     * so a changed default cannot quietly open the app up, and this test is
     * what makes that spelling-out mean something.
     */
    expect(recorder.options?.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
  });

  it("points at the CommonJS preload, not the ESM one", () => {
    /*
     * The bug that cost the most in this app. A SANDBOXED preload cannot be an
     * ES module -- Electron runs it "as plain JavaScript without an ESM
     * context" -- and this package is `"type": "module"`, so the default output
     * was `index.mjs`. A sandboxed renderer fails to load that SILENTLY: no
     * bridge, no error, and the app falls back to in-memory credentials, so
     * the user is signed out on every restart and nothing says why.
     */
    const preload = String(recorder.options?.webPreferences?.preload ?? "");

    expect(preload).toEndWith("/preload/index.cjs");
  });

  it("opens hidden and reveals itself only when there is something to show", () => {
    // `show: false` plus `ready-to-show`. Shown immediately, the window is a
    // white rectangle until the bundle parses.
    expect(recorder.options).toMatchObject({ show: false });
    expect(recorder.windowCalls).toContain("once:ready-to-show");
    expect(recorder.windowCalls).toContain("show");
  });

  it("loads the packaged renderer from disk when no dev server is set", () => {
    expect(
      recorder.windowCalls.some((call) => call.startsWith("loadFile:"))
    ).toBe(true);
  });
});

describe("what the renderer may ask the OS to do", () => {
  let recorder: Recorder;

  beforeAll(async () => {
    await buildOnce();
    recorder = newRecorder();
    await loadMain(recorder);
    await Bun.sleep(20);
  }, 300_000);

  it("hands http and https links to the real browser", () => {
    const result = recorder.openHandler?.({ url: "https://example.test/x" });

    expect(result).toEqual({ action: "deny" });
    expect(recorder.opened).toContain("https://example.test/x");
  });

  it("refuses every scheme that is not http or https", () => {
    /*
     * The check that turns "open a link" back into "open a link".
     * `shell.openExternal` hands whatever it is given to the platform handler,
     * and that includes `file://`, `smb://` and, on Windows, schemes that
     * execute. A compromised renderer must not be able to reach those.
     */
    const before = recorder.opened.length;

    for (const url of [
      "file:///etc/passwd",
      "smb://attacker.test/share",
      "javascript:alert(1)",
      "ms-msdt:/id",
      "not a url at all",
    ]) {
      recorder.openHandler?.({ url });
    }

    expect(recorder.opened.slice(before)).toEqual([]);
  });

  it("refuses the same schemes through the IPC channel", () => {
    // Two doors to the same room: the window-open handler and
    // `app:open-external`. Both go through the one validating function.
    const before = recorder.opened.length;
    const openExternal = recorder.channels["app:open-external"];

    openExternal?.({}, "file:///etc/passwd");
    expect(recorder.opened.slice(before)).toEqual([]);

    openExternal?.({}, "https://example.test/ok");
    expect(recorder.opened.slice(before)).toEqual(["https://example.test/ok"]);
  });

  it("blocks navigation away from the app, and opens it outside instead", () => {
    /*
     * Navigating the window away replaces the app with a web page, in a frame
     * with no address bar and no way back -- the classic Electron phishing
     * surface.
     */
    let prevented = false;
    const event = {
      preventDefault: () => {
        prevented = true;
      },
    };

    recorder.contentsEvents["will-navigate"]?.(event, "https://evil.test/");

    expect(prevented).toBe(true);
    expect(recorder.opened).toContain("https://evil.test/");
  });

  it("allows the packaged renderer's own file:// URL", () => {
    let prevented = false;
    const event = {
      preventDefault: () => {
        prevented = true;
      },
    };

    recorder.contentsEvents["will-navigate"]?.(
      event,
      "file:///Applications/Astro.app/Contents/renderer/index.html"
    );

    expect(prevented).toBe(false);
  });

  it("registers only the channels the bridge names", () => {
    /*
     * The renderer's entire reach into the OS. A channel appearing here that
     * the preload does not expose is dead surface; one the preload calls but
     * that is missing here is a bridge method that rejects at runtime.
     */
    expect(Object.keys(recorder.channels).sort()).toEqual([
      "app:open-external",
      "app:version",
      "credentials:backend",
      "credentials:clear",
      "credentials:get",
      "credentials:remove",
      "credentials:set",
    ]);
  });
});

describe("the content security policy", () => {
  let recorder: Recorder;
  let policy: string;

  /**
   * Loaded with VITE_API_URL absent from the environment.
   *
   * That is the packaged condition, and it has to be arranged deliberately
   * here: `bun test` runs from this directory and Bun loads `.env` on its own,
   * so the variable IS present in this process and would win over the value
   * compiled into the bundle -- hiding exactly the branch that ships.
   */
  beforeAll(async () => {
    await buildOnce();
    const saved = process.env.VITE_API_URL;
    // Deleted, not set to undefined: assigning `undefined` to a `process.env`
    // key stores the STRING "undefined", which reads as present.
    delete process.env.VITE_API_URL;

    recorder = newRecorder();
    await loadMain(recorder);
    await Bun.sleep(20);

    if (saved !== undefined) {
      process.env.VITE_API_URL = saved;
    }

    let captured = "";
    recorder.headers?.({ responseHeaders: {} }, (result) => {
      captured = result.responseHeaders["Content-Security-Policy"]?.[0] ?? "";
    });
    policy = captured;
  }, 300_000);

  it("is applied to every response, not declared in a meta tag", () => {
    // Set on the session so one policy covers the dev server and the packaged
    // `file://` load alike.
    expect(recorder.headers).toBeDefined();
    expect(policy.length).toBeGreaterThan(50);
  });

  it("uses the origin compiled in at build time when the environment has none", () => {
    /*
     * The bug this suite found, and the reason `envPrefix: "VITE_"` is on the
     * main config.
     *
     * The main process is Node: `VITE_*` is inlined into the RENDERER, and
     * without that prefix the main bundle had only `process.env` to read. An
     * app launched from Finder or Explorer has no shell environment, so the
     * CSP fell back to `http://localhost:3001` in every installed build --
     * blocking the real API and the gateway socket -- while `bun run dev`,
     * which inherits the developer's shell, looked perfectly correct.
     */
    const api = new URL(SENTINEL.apiUrl);

    expect(policy).toContain(api.origin);
    expect(policy).toContain(`ws://${api.host}`);
    expect(policy).not.toContain("localhost:3001");
  });

  it("still lets the environment override it, for pointing a build elsewhere", async () => {
    const saved = process.env.VITE_API_URL;
    process.env.VITE_API_URL = "https://staging.example.test";

    const other = newRecorder();
    await loadMain(other);
    await Bun.sleep(20);

    let captured = "";
    other.headers?.({ responseHeaders: {} }, (result) => {
      captured = result.responseHeaders["Content-Security-Policy"]?.[0] ?? "";
    });

    if (saved === undefined) {
      delete process.env.VITE_API_URL;
    } else {
      process.env.VITE_API_URL = saved;
    }

    expect(captured).toContain("https://staging.example.test");
    // https flips the socket scheme with it; a wss page cannot open ws.
    expect(captured).toContain("wss://staging.example.test");
  }, 300_000);

  it("permits no plugins, no framing, and no remote script", () => {
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("default-src 'self'");
  });

  it("does not allow inline script, only inline style", () => {
    // Vite injects styles inline, so `style-src` needs it. `script-src` must
    // not: `'unsafe-inline'` there is most of what a CSP is for.
    const scriptSrc = policy
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("script-src"));

    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
  });
});

describe("a second launch", () => {
  it("quits instead of running twice when the lock is held", async () => {
    /*
     * Two instances would fight over the credential file and open a second
     * gateway socket, which the server counts as a second device.
     */
    await buildOnce();
    const recorder = newRecorder(false);
    await loadMain(recorder);
    await Bun.sleep(20);

    expect(recorder.quit).toBe(1);
    expect(recorder.options).toBeUndefined();
  }, 300_000);

  it("focuses the existing window when the lock is held by us", async () => {
    await buildOnce();
    const recorder = newRecorder();
    await loadMain(recorder);
    await Bun.sleep(20);

    recorder.appEvents["second-instance"]?.();

    expect(recorder.windowCalls).toContain("restore");
    expect(recorder.windowCalls).toContain("focus");
  }, 300_000);
});
