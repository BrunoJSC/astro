import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, ipcMain, safeStorage } from "electron";

/**
 * Credential storage, in the main process, behind `safeStorage`.
 *
 * This is the reason the migration was worth doing. Tauri v2 ships no keychain
 * plugin, so the session token sat in a plaintext JSON file; Electron's
 * `safeStorage` is a first-party API backed by the Keychain on macOS, DPAPI on
 * Windows and libsecret/kwallet on Linux.
 *
 * Two things about it that are easy to get wrong.
 *
 * **It does not persist anything.** `encryptString` hands back a Buffer and
 * that is the end of its involvement -- writing the ciphertext somewhere is
 * this module's job. The file is in `userData`, so it is per-user and removed
 * with the app.
 *
 * **On Linux it may not encrypt at all.** With no secret service running,
 * `getSelectedStorageBackend()` returns `basic_text` and the data is encrypted
 * with a hardcoded password, which protects nothing. That is reported honestly
 * through `describeBackend` rather than papered over -- the renderer shows it,
 * and code that has to decide what is safe to persist can ask.
 *
 * Everything here runs in the main process. The renderer never sees a key, a
 * path, or `ipcRenderer`; it gets the four methods in `../preload`.
 */

const FILE = join(app.getPath("userData"), "credentials.bin");

/** Cleartext view of the store, loaded once and written back whole. */
let cache: Record<string, string> | undefined;

export interface BackendInfo {
  /** False on Linux with no keyring: the bytes are obfuscated, not protected. */
  encrypted: boolean;
  name: string;
}

export function describeBackend(): BackendInfo {
  if (!safeStorage.isEncryptionAvailable()) {
    return { encrypted: false, name: "unavailable" };
  }

  if (process.platform === "linux") {
    const backend = safeStorage.getSelectedStorageBackend();
    return {
      encrypted: backend !== "basic_text",
      name: `safeStorage (${backend})`,
    };
  }

  return {
    encrypted: true,
    name:
      process.platform === "darwin"
        ? "safeStorage (Keychain)"
        : "safeStorage (DPAPI)",
  };
}

async function load(): Promise<Record<string, string>> {
  if (cache) {
    return cache;
  }

  try {
    const bytes = await readFile(FILE);
    cache = JSON.parse(safeStorage.decryptString(bytes)) as Record<
      string,
      string
    >;
  } catch {
    /*
     * A missing file is the first run. A file that fails to decrypt is a real
     * situation too -- the OS key changed, the user restored a backup onto
     * another machine, the keyring was reset -- and the only recovery is to
     * treat the store as empty, which signs the user out. Refusing to start
     * would be worse.
     */
    cache = {};
  }

  return cache;
}

async function persist(): Promise<void> {
  if (!(cache && safeStorage.isEncryptionAvailable())) {
    return;
  }

  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, safeStorage.encryptString(JSON.stringify(cache)), {
    // Owner-only. Belt and braces next to the encryption: on the Linux
    // basic_text path it is the only thing actually protecting the file.
    mode: 0o600,
  });
}

/**
 * Wires the IPC handlers. Call after `app.whenReady`.
 *
 * On Linux `isEncryptionAvailable` only answers truthfully once the app is
 * ready and the secret key has been resolved, so registering earlier would
 * report the wrong backend to the first caller.
 */
export function registerCredentialHandlers(): void {
  ipcMain.handle("credentials:get", async (_event, key: string) => {
    const store = await load();
    return store[key] ?? null;
  });

  ipcMain.handle(
    "credentials:set",
    async (_event, key: string, value: string) => {
      const store = await load();
      store[key] = value;
      await persist();
    }
  );

  ipcMain.handle("credentials:remove", async (_event, key: string) => {
    const store = await load();
    delete store[key];
    await persist();
  });

  ipcMain.handle("credentials:clear", async () => {
    cache = {};
    await persist();
  });

  ipcMain.handle("credentials:backend", () => describeBackend());
}
