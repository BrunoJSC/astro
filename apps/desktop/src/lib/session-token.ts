import { getSecureStorage } from "./storage";

/**
 * The bearer session token, and the only place that knows where it lives.
 *
 * Better Auth's `bearer()` plugin returns the token in a `set-auth-token`
 * response header on sign-in, and accepts it back as `Authorization: Bearer`.
 * That is the whole exchange; this module just holds the middle of it.
 *
 * An in-memory mirror sits in front of the storage. The token is read on every
 * outgoing request and on every socket connect, and in a Tauri window each read
 * would otherwise be an IPC round trip to the Rust side for a value that
 * changes twice in a session.
 *
 * The mirror is the cache, never the source: `clear` empties both, so a
 * sign-out cannot leave a live token behind in memory for the next request to
 * find.
 */

const KEY = "session_token";

let cached: string | null | undefined;

/** Warms the mirror. Call once at startup, before the first request. */
export async function loadSessionToken(): Promise<string | null> {
  cached = await getSecureStorage().getItem(KEY);
  return cached;
}

/**
 * The token, from the mirror when warm and from storage otherwise.
 *
 * Returns `undefined` rather than null when absent, because that is what
 * better-fetch's `auth.token` treats as "send no Authorization header". Null
 * would be coerced into the literal string "null".
 */
export async function getSessionToken(): Promise<string | undefined> {
  if (cached === undefined) {
    await loadSessionToken();
  }
  return cached ?? undefined;
}

export async function setSessionToken(token: string): Promise<void> {
  cached = token;
  await getSecureStorage().setItem(KEY, token);
}

export async function clearSessionToken(): Promise<void> {
  cached = null;
  await getSecureStorage().removeItem(KEY);
}

/**
 * Stores the token from a sign-in response, if there is one.
 *
 * Every authenticated response passes through here, and most carry no header --
 * the plugin only emits it when a session is created. Returning a boolean lets
 * the caller tell "signed in just now" from "already signed in".
 */
export async function captureSessionToken(
  response: Response
): Promise<boolean> {
  const token = response.headers.get("set-auth-token");
  if (!token) {
    return false;
  }

  await setSessionToken(token);
  return true;
}
