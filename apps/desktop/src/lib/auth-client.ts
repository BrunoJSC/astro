import { usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { env } from "../env";

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
 * KNOWN OPEN ITEM -- session persistence.
 *
 * This client relies on the webview's cookie jar, which works in `tauri dev`
 * against a plain http origin and is the least surprising default. It is not
 * guaranteed in a packaged build: the window's origin is `tauri://localhost`,
 * so a cookie set by the API is third-party, and WKWebView and WebView2 both
 * block those by default. The symptom is sign-in appearing to succeed and the
 * session being gone on the next request.
 *
 * The fix, when it bites, is Better Auth's `bearer` plugin on the server plus
 * storing the returned token here -- in the OS keychain via a Tauri command,
 * not in localStorage, which is plaintext on disk in the app's data directory.
 * That is a real feature with a server-side half, so it is deliberately not
 * guessed at in a skeleton.
 */
export const authClient = createAuthClient({
  baseURL: env.VITE_API_URL,
  // Same pairing as the web and native clients: the server registers
  // `username()`, so every client that should reach those endpoints registers
  // this one. The lists have to stay in step; that pairing is the contract.
  plugins: [usernameClient()],
});

export const { getSession, isUsernameAvailable, signIn, signOut, useSession } =
  authClient;

/*
 * `signUp` and `updateUser` are annotated rather than destructured: their
 * inferred types reference internal Better Auth types that TypeScript cannot
 * name portably (TS2883), and the declaration would not survive emit. Naming
 * them through `typeof authClient.x` keeps the reference local.
 */
export const signUp: typeof authClient.signUp = authClient.signUp;
export const updateUser: typeof authClient.updateUser = authClient.updateUser;

export type AuthClient = typeof authClient;
