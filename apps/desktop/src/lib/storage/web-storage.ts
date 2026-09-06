import { createMemoryStorage } from "./memory-storage";
import type { SecureStorage } from "./secure-storage.interface";

/**
 * `localStorage`, for the browser and for `vite` outside the Tauri runtime.
 *
 * PLAINTEXT. In a browser it is protected by the origin sandbox, which is a
 * real boundary. Inside a packaged Tauri app it is a file in the app's data
 * directory that any process running as the user can read -- weaker than the
 * cookie the browser would have held.
 *
 * Every access is guarded. `localStorage` throws rather than returning null in
 * a surprising number of situations: Safari in private mode, a browser
 * configured to block site data, and any embedding that runs the page from a
 * null origin. A credential store that throws on read takes the whole app down
 * at startup, so failures degrade to memory instead.
 */
export function createWebStorage(prefix = "astro:"): SecureStorage {
  const available = (() => {
    try {
      const probe = `${prefix}__probe`;
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  })();

  if (!available) {
    return createMemoryStorage();
  }

  return {
    clear: () => {
      // Only this app's keys. `localStorage.clear()` would take everything on
      // the origin, including whatever else is stored beside it.
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(prefix)) {
          localStorage.removeItem(key);
        }
      }
      return Promise.resolve();
    },
    durability: "plaintext",
    getItem: (key) => Promise.resolve(localStorage.getItem(prefix + key)),
    name: "localStorage",
    removeItem: (key) => {
      localStorage.removeItem(prefix + key);
      return Promise.resolve();
    },
    setItem: (key, value) => {
      localStorage.setItem(prefix + key, value);
      return Promise.resolve();
    },
  };
}
