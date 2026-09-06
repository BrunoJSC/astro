/**
 * The renderer's entire reach into the operating system.
 *
 * Written as a type so both sides compile against the same shape: the preload
 * implements it, the renderer consumes it through `window.astro`.
 *
 * Everything here is a specific verb. The bridge deliberately does not expose
 * `ipcRenderer`, a channel name, or anything that takes a path -- a renderer
 * that can name its own IPC channel can reach every handler the main process
 * has, which defeats the point of having a bridge at all.
 */
export interface CredentialBackend {
  /** False on Linux with no keyring: obfuscated with a fixed key, not secured. */
  encrypted: boolean;
  name: string;
}

export interface AstroBridge {
  credentials: {
    backend: () => Promise<CredentialBackend>;
    clear: () => Promise<void>;
    get: (key: string) => Promise<string | null>;
    remove: (key: string) => Promise<void>;
    set: (key: string, value: string) => Promise<void>;
  };
  /** Hands the URL to the user's browser. Refused unless http(s). */
  openExternal: (url: string) => Promise<void>;
  platform: NodeJS.Platform;
  version: () => Promise<string>;
}

declare global {
  interface Window {
    /** Absent in a plain browser tab. Its presence is the runtime check. */
    astro?: AstroBridge;
  }
}
