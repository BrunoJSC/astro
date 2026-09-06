import { clientEnv } from "@repo/env/client";
import { usernameClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Browser/React client. `baseURL` points at whichever app mounts the
 * Better Auth handler -- by default the API in `apps/server`.
 *
 * React Native consumers should build their own client with
 * `better-auth/client` plus `@better-auth/expo`, since this entry point
 * pulls in React DOM-oriented hooks.
 */
export const authClient = createAuthClient({
  baseURL: clientEnv.NEXT_PUBLIC_API_URL,
  /*
   * The client plugin is what types `signIn.username` and
   * `isUsernameAvailable` -- without it those calls do not exist on the client,
   * even though the server already answers the endpoints. The server and client
   * plugin lists have to stay in step; that pairing is the contract.
   */
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
