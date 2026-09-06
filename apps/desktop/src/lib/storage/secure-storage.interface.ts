/**
 * The contract every credential store satisfies.
 *
 * Asynchronous throughout, including the backends that could answer
 * synchronously. The Tauri backend crosses an IPC boundary and cannot be
 * anything else, and a synchronous interface would force every caller to be
 * rewritten the day the backend changes -- which is the one thing this
 * abstraction exists to prevent.
 */
export interface ISecureStorage {
  clear: () => Promise<void>;
  getItem: (key: string) => Promise<string | null>;
  removeItem: (key: string) => Promise<void>;
  setItem: (key: string, value: string) => Promise<void>;
}

/**
 * How securely a backend actually holds what it is given.
 *
 * Exposed rather than assumed, because the honest answer today is "not very"
 * and code that decides what to persist should be able to ask. A refresh token
 * belongs somewhere `encrypted`; a UI preference does not care.
 */
export type StorageDurability =
  /** Gone when the process exits. Safest, and useless for staying signed in. */
  | "ephemeral"
  /** Survives restarts, readable by anything with filesystem access. */
  | "plaintext"
  /** Survives restarts, protected by the OS or a key the app does not hold. */
  | "encrypted";

export interface SecureStorage extends ISecureStorage {
  /**
   * How well this backend actually protects what it holds.
   *
   * Asynchronous because the honest answer is not always known locally. The
   * Electron backend has to ask the main process which `safeStorage` backend
   * the OS gave it -- on Linux with no keyring that is `basic_text`, a fixed
   * password, which protects nothing. Reporting "encrypted" and correcting it
   * later would be worse than making the caller wait.
   */
  durability: () => Promise<StorageDurability>;
  readonly name: string;
}
