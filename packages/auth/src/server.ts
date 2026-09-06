import { db, newId, schema } from "@repo/db";
import { env } from "@repo/env/server";
import argon2 from "argon2";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, username } from "better-auth/plugins";

/** Compiled once: the validators run on every sign-up, sign-in and update. */
const USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;
const DISPLAY_USERNAME_PATTERN = /^[a-zA-Z0-9_]+$/;

/**
 * Argon2id parameters from the OWASP Password Storage Cheat Sheet:
 * m = 19 MiB, t = 2, p = 1.
 *
 * Argon2id is the hybrid variant -- resistant to both GPU cracking and
 * side-channel attacks -- and is what OWASP lists first for new applications.
 * Better Auth would otherwise fall back to its own scrypt, which costs ~8x the
 * latency and ~7x the memory per login for equivalent security, because
 * scrypt pins memory to `128 * N * r` while Argon2 moves memory, time and
 * parallelism on independent axes.
 *
 * Measured on an Intel i5-5257U @ 2.7 GHz; a modern server core runs roughly
 * 3-4x faster:
 *
 *   m=19 MiB, t=2, p=1    67 ms   <- current
 *   m=64 MiB, t=3, p=1   317 ms
 *
 * The parameters are encoded into each hash, so raising the cost later does
 * not invalidate existing passwords -- `verify` reads them back per hash.
 */
export const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  parallelism: 1,
  timeCost: 2,
  type: argon2.argon2id,
} as const;

export const auth = betterAuth({
  advanced: {
    database: {
      // UUIDv7 for every row Better Auth creates, matching the schema's own
      // primary keys (see @repo/db's `newId`).
      generateId: () => newId(),
    },
  },
  baseURL: env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
    password: {
      hash: (password) => argon2.hash(password, ARGON2_OPTIONS),
      // `argon2.verify` throws on a hash it cannot parse. A malformed stored
      // hash is a failed login, not a crashed request, so it folds into false.
      verify: async ({ hash, password }) => {
        try {
          return await argon2.verify(hash, password);
        } catch {
          return false;
        }
      },
    },
  },
  plugins: [
    /*
     * Session by `Authorization: Bearer <token>` as well as by cookie.
     *
     * Added for the clients that cannot hold a cookie. A Tauri window is served
     * from `tauri://localhost`, so the API's cookie is third-party to it and
     * both WKWebView and WebView2 block those by default -- sign-in appears to
     * work and the session is gone on the next request. React Native has no
     * cookie jar at all.
     *
     * It changes nothing for the web app: the hooks only engage when an
     * Authorization header is present, and a browser keeps sending its cookie.
     *
     * The plugin does two things. Before a request, it converts the bearer
     * token into the session cookie the rest of Better Auth expects, so every
     * endpoint keeps working unchanged. After a sign-in, it returns the token
     * in a `set-auth-token` response header for the client to store.
     *
     * `requireSignature` stays false to match how the cookie is issued; turning
     * it on rejects tokens that were not signed, and would invalidate every
     * token already handed out.
     */
    bearer(),
    username({
      displayUsernameValidator: (value) => DISPLAY_USERNAME_PATTERN.test(value),
      // Changing a username later is allowed, through updateUser. Set true if
      // you need handles to be permanent -- it cannot be relaxed afterwards
      // without invalidating whatever relied on the guarantee.
      immutableUsername: false,
      maxUsernameLength: 30,
      minUsernameLength: 3,
      /*
       * Case-INSENSITIVE on purpose, even though the stored value is always
       * lower-cased by the normalizer.
       *
       * `validationOrder` cannot fix this: better-auth 1.7.2 reads the flag
       * with opposite senses on the two paths -- sign-up normalizes before
       * validating when it is "post-normalization", while sign-in normalizes
       * when it is "pre-normalization". No single value covers both, so a
       * lower-case-only pattern rejects `ADA_LOVELACE` at sign-in with
       * INVALID_USERNAME. Accepting either case here lets the normalizer do
       * its job on both routes.
       *
       * No dots or dashes: a username must never be confusable with an email
       * or collide with a URL path segment.
       */
      usernameValidator: (value) => USERNAME_PATTERN.test(value),
    }),
  ],
  secret: env.BETTER_AUTH_SECRET,
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh once a day
  },
  // Apps served from other origins (Expo, Tauri) must be listed here.
  trustedOrigins: [env.BETTER_AUTH_URL],
});

export type Auth = typeof auth;
export type Session = Auth["$Infer"]["Session"];
