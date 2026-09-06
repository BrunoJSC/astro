import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { sharedSchema } from "./shared";

/**
 * Public variables, inlined at build time by the bundler.
 *
 * `runtimeEnv` must list every key literally -- Next.js and Metro replace
 * `process.env.NEXT_PUBLIC_*` / `process.env.EXPO_PUBLIC_*` by static
 * analysis, so a spread of `process.env` would come back undefined.
 *
 * Note: `clientPrefix` accepts a single prefix. Apps on Expo should mirror
 * these keys under EXPO_PUBLIC_ in their own `createEnv` call.
 */
export const clientSchema = {
  NEXT_PUBLIC_API_URL: z.string().url(),
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
} as const;

export const clientEnv = createEnv({
  client: clientSchema,
  clientPrefix: "NEXT_PUBLIC_",
  emptyStringAsUndefined: true,
  runtimeEnv: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NODE_ENV: process.env.NODE_ENV,
  },
  shared: sharedSchema,
  skipValidation: Boolean(process.env.SKIP_ENV_VALIDATION),
});

export type ClientEnv = typeof clientEnv;
