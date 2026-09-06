import { expoClient } from "@better-auth/expo/client";
import { nativeEnv } from "@repo/env/native";
import { usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";

/**
 * Better Auth client for the app.
 *
 * `@repo/auth/client` is not reused here: it targets the browser, where the
 * session cookie is held by the platform. React Native has no cookie jar, so
 * the Expo plugin persists the session token itself -- in SecureStore, which
 * is the Keychain on iOS and EncryptedSharedPreferences on Android, rather
 * than AsyncStorage where it would sit in plaintext on disk.
 *
 * `scheme` must match `expo.scheme` in app.json: it is the deep link the OAuth
 * provider redirects back to when a social sign-in completes.
 */
export const authClient = createAuthClient({
  baseURL: nativeEnv.EXPO_PUBLIC_API_URL,
  plugins: [
    // Same pairing as the web client: the server registers `username()`, so
    // every client that should reach those endpoints registers this one.
    usernameClient(),
    expoClient({
      scheme: "astro",
      storage: SecureStore,
      storagePrefix: "astro",
    }),
  ],
});

export const { isUsernameAvailable, signIn, signOut, useSession } = authClient;

/*
 * `signUp` and `updateUser` are annotated rather than destructured: their
 * inferred types reference internal Better Auth types that TypeScript cannot
 * name portably (TS2883), and the declaration would not survive emit. Naming
 * them through `typeof authClient.x` keeps the reference local.
 */
export const signUp: typeof authClient.signUp = authClient.signUp;
export const updateUser: typeof authClient.updateUser = authClient.updateUser;
