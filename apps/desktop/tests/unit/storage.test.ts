import { beforeEach, describe, expect, it } from "bun:test";
import { createMemoryStorage } from "../../src/lib/storage/memory-storage";
import { createWebStorage } from "../../src/lib/storage/web-storage";

/**
 * The storage backends, against the one contract they all satisfy.
 *
 * The same suite runs over each of them: an adapter whose whole purpose is to
 * be swapped is only useful if the swap is invisible to callers, and the way to
 * know that is to assert the same behaviour of every implementation.
 *
 * `tauri-storage` is absent because it needs the Tauri IPC bridge, which does
 * not exist in a test process. Its contribution -- persisting across restarts
 * -- is the part no unit test can observe anyway.
 */

/**
 * A minimal `localStorage`, because Bun's test runtime has none.
 *
 * Data lives in enumerable own properties and the methods are defined
 * non-enumerable, so `Object.keys` returns the stored keys and nothing else --
 * which is what `createWebStorage`'s prefix-scoped `clear` walks.
 */
function installLocalStorage(): void {
  const store: Record<string, unknown> = {};

  const define = (name: string, fn: (...args: string[]) => unknown) =>
    Object.defineProperty(store, name, { enumerable: false, value: fn });

  define("getItem", (key: string) =>
    Object.hasOwn(store, key) ? (store[key] as string) : null
  );
  define("setItem", (key: string, value: string) => {
    store[key] = String(value);
  });
  define("removeItem", (key: string) => {
    delete store[key];
  });
  define("clear", () => {
    for (const key of Object.keys(store)) {
      delete store[key];
    }
  });

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: store,
    writable: true,
  });
}

installLocalStorage();

// Not `as const`: `describe.each` takes a mutable array, and a readonly tuple
// fails to match its overloads.
const backends = [
  { make: createMemoryStorage, name: "memory" },
  { make: () => createWebStorage("test:"), name: "web" },
];

beforeEach(() => {
  localStorage.clear();
});

describe.each(backends)("$name storage", ({ make }) => {
  it("round-trips a value", async () => {
    const storage = make();
    await storage.setItem("token", "abc");
    expect(await storage.getItem("token")).toBe("abc");
  });

  it("returns null for a key that was never set", async () => {
    // Null, not undefined and not a throw: callers branch on it directly.
    expect(await make().getItem("missing")).toBeNull();
  });

  it("overwrites rather than appending", async () => {
    const storage = make();
    await storage.setItem("token", "first");
    await storage.setItem("token", "second");
    expect(await storage.getItem("token")).toBe("second");
  });

  it("removes a value", async () => {
    const storage = make();
    await storage.setItem("token", "abc");
    await storage.removeItem("token");
    expect(await storage.getItem("token")).toBeNull();
  });

  it("removing something absent is not an error", async () => {
    await expect(make().removeItem("missing")).resolves.toBeUndefined();
  });

  it("clears everything it owns", async () => {
    const storage = make();
    await storage.setItem("a", "1");
    await storage.setItem("b", "2");
    await storage.clear();

    expect(await storage.getItem("a")).toBeNull();
    expect(await storage.getItem("b")).toBeNull();
  });

  it("declares how durable it is", async () => {
    // Callers branch on this rather than assuming: a refresh token belongs
    // somewhere `encrypted`, a UI preference does not care. Asynchronous
    // because the Electron backend has to ask the main process which
    // safeStorage backend the OS actually gave it.
    expect(["ephemeral", "plaintext", "encrypted"]).toContain(
      await make().durability()
    );
  });
});

describe("web storage", () => {
  it("namespaces its keys", async () => {
    const storage = createWebStorage("test:");
    await storage.setItem("token", "abc");
    expect(localStorage.getItem("test:token")).toBe("abc");
  });

  it("clears only its own prefix", async () => {
    // `localStorage.clear()` would take everything on the origin, including
    // whatever else is stored beside it.
    localStorage.setItem("someone-else", "keep me");
    const storage = createWebStorage("test:");
    await storage.setItem("token", "abc");

    await storage.clear();

    expect(localStorage.getItem("someone-else")).toBe("keep me");
  });
});

describe("memory storage", () => {
  it("does not share state between instances", async () => {
    // The test backend: one suite's tokens must not leak into the next.
    const a = createMemoryStorage();
    const b = createMemoryStorage();

    await a.setItem("token", "abc");

    expect(await b.getItem("token")).toBeNull();
  });
});
