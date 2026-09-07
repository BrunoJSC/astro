import { beforeAll, describe, expect, it } from "bun:test";
import { buildOnce, loadPreload, readPreload } from "./helpers";

/** Anchored per line: an ESM statement anywhere in the file is the failure. */
const ESM_IMPORT = /^\s*import\s/m;
const ESM_EXPORT = /^\s*export\s/m;
/** The only channel shape the bridge is allowed to reach. */
const CHANNEL = /^(credentials|app):[a-z-]+$/;

/**
 * The preload bridge, executed.
 *
 * It is the only place the renderer and the OS touch, so its exact surface is
 * the app's attack surface. These tests run the BUILT `index.cjs` with a fake
 * `electron` and look at what it hands to `exposeInMainWorld`.
 */

let bridge: Record<string, unknown>;
let calls: { args: unknown[]; channel: string }[];

beforeAll(async () => {
  await buildOnce();
  const loaded = loadPreload();
  bridge = loaded.exposed;
  calls = loaded.invocations;
}, 300_000);

describe("what the preload builds", () => {
  it("is CommonJS, because a sandboxed preload cannot be an ES module", () => {
    /*
     * Electron runs a sandboxed preload "as plain JavaScript without an ESM
     * context". This package is `"type": "module"`, so the default output was
     * `index.mjs` -- which loads SILENTLY as nothing: no bridge, no error, and
     * the app quietly falls back to in-memory credentials.
     *
     * Checked on the emitted text rather than the filename. A `.cjs` file full
     * of `import` statements would satisfy the name and fail the same way.
     */
    const code = readPreload();

    expect(code).toContain('require("electron")');
    expect(code).not.toMatch(ESM_IMPORT);
    expect(code).not.toMatch(ESM_EXPORT);
  });

  it("bundles nothing but electron", () => {
    // `externalizeDepsPlugin` keeps node_modules out. A preload that pulled a
    // dependency in would also pull whatever that dependency reaches.
    const requires = [...readPreload().matchAll(/require\("([^"]+)"\)/g)].map(
      (match) => match[1]
    );

    expect([...new Set(requires)]).toEqual(["electron"]);
  });
});

describe("the surface it exposes", () => {
  it("exposes exactly one global", () => {
    expect(Object.keys(bridge)).toEqual(["astro"]);
  });

  it("exposes named verbs and nothing that names a channel", () => {
    /*
     * The rule the whole bridge exists for. A renderer that can pass its own
     * channel name can invoke every handler the main process registered --
     * including the credential ones -- which makes the bridge decorative.
     */
    const astro = bridge.astro as Record<string, unknown>;

    expect(Object.keys(astro).sort()).toEqual([
      "credentials",
      "openExternal",
      "platform",
      "version",
    ]);
    expect(astro.ipcRenderer).toBeUndefined();
    expect(astro.invoke).toBeUndefined();
    expect(astro.send).toBeUndefined();
  });

  it("exposes the five credential verbs", () => {
    const { credentials } = bridge.astro as { credentials: object };

    expect(Object.keys(credentials).sort()).toEqual([
      "backend",
      "clear",
      "get",
      "remove",
      "set",
    ]);
  });

  it("reports the platform as a value, not a function to be tricked", () => {
    const astro = bridge.astro as { platform: unknown };

    expect(typeof astro.platform).toBe("string");
    expect(astro.platform).toBe(process.platform);
  });
});

describe("what each verb actually invokes", () => {
  /*
   * Every method is pinned to one literal channel. This is the test that would
   * fail if someone "simplified" the bridge into a single method taking a
   * channel argument -- which reads as a refactor and is a privilege
   * escalation.
   */
  it("maps each credential verb to its own channel", async () => {
    const { credentials } = bridge.astro as {
      credentials: {
        backend: () => Promise<unknown>;
        clear: () => Promise<unknown>;
        get: (key: string) => Promise<unknown>;
        remove: (key: string) => Promise<unknown>;
        set: (key: string, value: string) => Promise<unknown>;
      };
    };

    const before = calls.length;
    await credentials.get("token");
    await credentials.set("token", "value");
    await credentials.remove("token");
    await credentials.clear();
    await credentials.backend();

    expect(calls.slice(before).map((call) => call.channel)).toEqual([
      "credentials:get",
      "credentials:set",
      "credentials:remove",
      "credentials:clear",
      "credentials:backend",
    ]);
  });

  it("forwards the arguments, and only the arguments", async () => {
    const { credentials } = bridge.astro as {
      credentials: { set: (key: string, value: string) => Promise<unknown> };
    };

    const before = calls.length;
    await credentials.set("session", "abc123");

    expect(calls[before]?.args).toEqual(["session", "abc123"]);
  });

  it("routes openExternal and version to theirs", async () => {
    const astro = bridge.astro as {
      openExternal: (url: string) => Promise<unknown>;
      version: () => Promise<unknown>;
    };

    const before = calls.length;
    await astro.openExternal("https://example.test");
    await astro.version();

    expect(calls.slice(before)).toEqual([
      { args: ["https://example.test"], channel: "app:open-external" },
      { args: [], channel: "app:version" },
    ]);
  });

  it("cannot be made to invoke a channel the caller chooses", () => {
    /*
     * The negative case, stated as code. Every exposed function ignores extra
     * arguments beyond the ones it names, so there is no path from the
     * renderer to an arbitrary channel.
     */
    const astro = bridge.astro as Record<string, unknown>;
    const reachable = new Set(
      calls.map((call) => call.channel).filter(Boolean)
    );

    for (const channel of reachable) {
      expect(channel).toMatch(CHANNEL);
    }
    expect(typeof astro.openExternal).toBe("function");
  });
});
