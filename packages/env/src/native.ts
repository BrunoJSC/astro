import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { sharedSchema } from "./shared.ts";

/**
 * Public variables for the Expo app.
 *
 * A separate entry point from `./client` because T3 Env's `clientPrefix` takes
 * a single prefix, and Metro inlines `EXPO_PUBLIC_*` where Next inlines
 * `NEXT_PUBLIC_*`. Sharing one module would leave whichever bundler is not
 * running with undefined values.
 *
 * `runtimeEnv` lists every key literally for the same reason it does on the
 * web: Metro replaces these by static analysis, so a spread of `process.env`
 * comes back empty in a release build.
 */
export const nativeSchema = {
  EXPO_PUBLIC_API_URL: z.string().url(),
} as const;

export const nativeEnv = createEnv({
  client: nativeSchema,
  clientPrefix: "EXPO_PUBLIC_",
  emptyStringAsUndefined: true,
  runtimeEnv: {
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
    NODE_ENV: process.env.NODE_ENV,
  },
  shared: sharedSchema,
  skipValidation: Boolean(process.env.SKIP_ENV_VALIDATION),
});

export type NativeEnv = typeof nativeEnv;
