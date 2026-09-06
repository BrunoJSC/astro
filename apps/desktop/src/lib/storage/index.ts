import { createMemoryStorage } from "./memory-storage";
import type { SecureStorage } from "./secure-storage.interface";
import { createTauriStorage } from "./tauri-storage";
import { createWebStorage } from "./web-storage";

export type {
  ISecureStorage,
  SecureStorage,
  StorageDurability,
} from "./secure-storage.interface";

/**
 * Whether the page is running inside a Tauri window.
 *
 * `__TAURI_INTERNALS__` is the v2 marker. v1 exposed `__TAURI__`, which v2 only
 * defines when `withGlobalTauri` is set -- checking for it would report false
 * inside a perfectly normal v2 app.
 *
 * Not a build-time constant on purpose: the same bundle is loaded by
 * `tauri dev` and by a browser pointed at the Vite server, and only the runtime
 * knows which one is which.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let instance: SecureStorage | undefined;

/**
 * The storage this environment should use.
 *
 * Tauri window -> the plugin store, a file the app owns.
 * Browser or Vite tab -> `localStorage`, which degrades to memory if the
 * browser refuses it.
 * No `window` at all (a test, a build step) -> memory.
 *
 * Resolved once and cached: two backends open on the same keys would drift the
 * moment one of them wrote.
 */
export function getSecureStorage(): SecureStorage {
  if (instance) {
    return instance;
  }

  if (typeof window === "undefined") {
    instance = createMemoryStorage();
  } else if (isTauri()) {
    instance = createTauriStorage();
  } else {
    instance = createWebStorage();
  }

  return instance;
}

/** Replaces the resolved backend. For tests, and for nothing else. */
export function setSecureStorage(storage: SecureStorage): void {
  instance = storage;
}
