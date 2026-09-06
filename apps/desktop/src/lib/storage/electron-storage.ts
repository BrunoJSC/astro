import { createMemoryStorage } from "./memory-storage";
import type { SecureStorage } from "./secure-storage.interface";

/**
 * `safeStorage`, reached through the preload bridge.
 *
 * The main process holds the key and the file; this side has four verbs and no
 * idea where anything lives. See `electron/main/credentials.ts`.
 *
 * This is what the migration from Tauri bought. Tauri v2 ships no keychain
 * plugin -- `plugin-store` writes plain JSON and `plugin-stronghold` needs a
 * password an auto-login app has nowhere to keep -- so the session token was
 * plaintext on disk. Here it is the OS Keychain on macOS and DPAPI on Windows.
 *
 * On Linux it depends on there being a secret service. Without one, Electron
 * falls back to a hardcoded password, and `durability` says `plaintext` rather
 * than claiming otherwise.
 */
export function createElectronStorage(): SecureStorage {
  const bridge = window.astro;

  if (!bridge) {
    // Only reachable if the preload failed to load, which would also mean the
    // window is broken -- but a credential store that throws on construction
    // takes the app down at import time.
    return createMemoryStorage();
  }

  return {
    clear: () => bridge.credentials.clear(),
    durability: async () => {
      const backend = await bridge.credentials.backend();
      return backend.encrypted ? "encrypted" : "plaintext";
    },
    getItem: (key) => bridge.credentials.get(key),
    name: "safeStorage",
    removeItem: (key) => bridge.credentials.remove(key),
    setItem: (key, value) => bridge.credentials.set(key, value),
  };
}
