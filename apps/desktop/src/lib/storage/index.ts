import { createElectronStorage } from "./electron-storage";
import { createMemoryStorage } from "./memory-storage";
import type { SecureStorage } from "./secure-storage.interface";
import { createWebStorage } from "./web-storage";

export type {
  ISecureStorage,
  SecureStorage,
  StorageDurability,
} from "./secure-storage.interface";

/**
 * Whether the page is running inside the Electron shell.
 *
 * The check is for the bridge this app's own preload installs, not for a
 * generic Electron marker. With `contextIsolation` on there is no `process` and
 * no `require` in the page, and sniffing the user agent for "Electron" would
 * report true in a window whose preload failed to load -- exactly the case
 * where the bridge is unusable.
 *
 * Not a build-time constant: the same renderer bundle is loaded by the shell
 * and by a browser pointed at the dev server, and only the runtime knows which.
 */
export function isElectron(): boolean {
  return typeof window !== "undefined" && window.astro !== undefined;
}

let instance: SecureStorage | undefined;

/**
 * The storage this environment should use.
 *
 * Electron shell -> `safeStorage`, through the preload bridge.
 * Browser or dev-server tab -> `localStorage`, which degrades to memory if the
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
  } else if (isElectron()) {
    instance = createElectronStorage();
  } else {
    instance = createWebStorage();
  }

  return instance;
}

/** Replaces the resolved backend. For tests, and for nothing else. */
export function setSecureStorage(storage: SecureStorage): void {
  instance = storage;
}
