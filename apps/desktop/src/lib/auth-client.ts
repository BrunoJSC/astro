import { usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { env } from "../env";
import {
  captureSessionToken,
  clearSessionToken,
  getSessionToken,
} from "./session-token";

/**
 * Better Auth client for the desktop app.
 *
 * `@repo/auth/client` is not reused, for the same reason the Expo app does not
 * reuse it: that module reads `@repo/env/client`, which resolves
 * `process.env.NEXT_PUBLIC_*`. Vite never defines those, so its `baseURL`
 * would be undefined here.
 *
 * ---
 *
 * ## Bearer, not cookie
 *
 * The cookie jar is not usable here. A packaged window is served from
 * `tauri://localhost`, so a cookie set by the API is third-party to it, and
 * WKWebView and WebView2 both block those by default -- sign-in appears to
 * succeed and the session is gone on the next request.
 *
 * So the server registers Better Auth's `bearer()` plugin, which returns the
 * session token in a `set-auth-token` header on sign-in and accepts it back as
 * `Authorization: Bearer`. `onSuccess` captures it, `auth.token` sends it, and
 * `./session-token` decides where it is kept.
 *
 * Where it is kept is honestly weaker than a cookie today: see
 * `./storage/tauri-storage.ts`. Neither official Tauri plugin gives the OS
 * keychain, and the file the token lands in is not encrypted.
 */
export const authClient = createAuthClient({
  baseURL: env.VITE_API_URL,
  fetchOptions: {
    // Sent on every request. `undefined` means no header at all, which is what
    // a signed-out client should send -- an empty Bearer would be rejected
    // rather than ignored.
    auth: {
      token: () => getSessionToken(),
      type: "Bearer",
    },
    onSuccess: async ({ response }) => {
      await captureSessionToken(response);
    },
  },
  // Same pairing as the web and native clients: the server registers
  // `username()`, so every client that should reach those endpoints registers
  // this one. The lists have to stay in step; that pairing is the contract.
  plugins: [usernameClient()],
});

export const { getSession, isUsernameAvailable, signIn, useSession } =
  authClient;

/**
 * Signs out, then drops the stored token.
 *
 * In that order, and both unconditionally. The server call needs the token to
 * revoke the right session, and the local copy has to go even when that call
 * fails -- otherwise a sign-out with no network leaves the app holding a
 * credential the user believes they discarded.
 */
export const signOut: typeof authClient.signOut = async (...args) => {
  try {
    return await authClient.signOut(...args);
  } finally {
    await clearSessionToken();
  }
};

/*
 * `signUp` and `updateUser` are annotated rather than destructured: their
 * inferred types reference internal Better Auth types that TypeScript cannot
 * name portably (TS2883), and the declaration would not survive emit. Naming
 * them through `typeof authClient.x` keeps the reference local.
 */
export const signUp: typeof authClient.signUp = authClient.signUp;
export const updateUser: typeof authClient.updateUser = authClient.updateUser;

export type AuthClient = typeof authClient;
