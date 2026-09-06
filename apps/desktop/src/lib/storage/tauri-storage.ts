import type { SecureStorage } from "./secure-storage.interface";

/**
 * `@tauri-apps/plugin-store` -- the official persistent key-value store.
 *
 * ## What this is NOT
 *
 * It is not the OS keychain, and it is worth being blunt about that because the
 * plugin names invite the opposite assumption.
 *
 * `plugin-store` writes a JSON file in the app's data directory. It is not
 * encrypted. Against a process running as the same user it is exactly as
 * exposed as `localStorage`; what it buys is a real file the app controls,
 * outside the webview's storage, which survives a cleared webview cache and can
 * be deleted deterministically on sign-out.
 *
 * `plugin-stronghold` is the encrypted alternative, and it does not fit an
 * auto-login token either. It is an IOTA vault written to a `.hold` snapshot,
 * and it must be opened with a password. For an app that signs the user in
 * without prompting, that password has to be stored somewhere the app can read
 * unattended -- which is the original problem, one indirection further down.
 *
 * The real answer is the OS keychain (Keychain, Credential Manager, Secret
 * Service), and Tauri v2 ships no official plugin for it. It needs a community
 * crate and a pair of Rust commands. That is a deliberate, separate decision:
 * see this package's README.
 *
 * ## Rust
 *
 * The JS half is useless alone. `src-tauri` must carry `tauri-plugin-store` and
 * register it, which is done in `src-tauri/src/lib.rs`.
 */

const STORE_FILE = "credentials.json";

type StoreModule = typeof import("@tauri-apps/plugin-store");

let cached: Promise<Awaited<ReturnType<StoreModule["load"]>>> | undefined;

/**
 * Imported lazily so a browser build never pulls it in.
 *
 * The module reaches for the Tauri IPC bridge on load; in a plain `vite dev`
 * tab that bridge does not exist, and a static import would break the page
 * before the runtime check could choose a different backend.
 */
function store() {
  cached ??= import("@tauri-apps/plugin-store").then((mod) =>
    mod.load(STORE_FILE, { autoSave: true })
  );
  return cached;
}

export function createTauriStorage(): SecureStorage {
  return {
    clear: async () => {
      await (await store()).clear();
    },
    durability: "plaintext",
    getItem: async (key) => {
      const value = await (await store()).get<string>(key);
      return value ?? null;
    },
    name: "tauri-store",
    removeItem: async (key) => {
      await (await store()).delete(key);
    },
    setItem: async (key, value) => {
      await (await store()).set(key, value);
    },
  };
}
