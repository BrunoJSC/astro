import type { SecureStorage } from "./secure-storage.interface";

/**
 * A Map behind the interface.
 *
 * The fallback when nothing else is available, and the right choice for tests:
 * a suite that writes real tokens into a real store leaks them between cases
 * and leaves them on disk afterwards.
 *
 * Signing in is lost on restart, which is correct rather than unfortunate --
 * an app that cannot persist a credential securely should not pretend it did.
 */
export function createMemoryStorage(): SecureStorage {
  const map = new Map<string, string>();

  return {
    clear: () => {
      map.clear();
      return Promise.resolve();
    },
    durability: "ephemeral",
    getItem: (key) => Promise.resolve(map.get(key) ?? null),
    name: "memory",
    removeItem: (key) => {
      map.delete(key);
      return Promise.resolve();
    },
    setItem: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
  };
}
