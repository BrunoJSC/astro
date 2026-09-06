import { z } from "zod";

/**
 * Variables available on BOTH server and client.
 *
 * This module exports a schema map only -- no `createEnv` call. T3 Env has no
 * shared-only mode (`createEnv` requires a `server` or `client` block), and
 * shared keys are meant to be composed into the other two, which is what
 * `./server` and `./client` do.
 */
export const sharedSchema = {
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
} as const;

export type SharedEnv = {
  [K in keyof typeof sharedSchema]: z.infer<(typeof sharedSchema)[K]>;
};
