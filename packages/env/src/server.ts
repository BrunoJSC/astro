import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { sharedSchema } from "./shared";

/**
 * Server-only variables. Importing this module from client code throws at
 * runtime -- that is intentional, it is the guard T3 Env provides.
 */
export const serverSchema = {
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  /**
   * Comma-separated CORS allowlist, parsed into an array here so the server
   * never re-parses it and an empty value fails validation instead of
   * silently becoming a wildcard.
   */
  CORS_ORIGINS: z
    .string()
    .min(1)
    .default("http://localhost:3000")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    ),
  /**
   * Runtime connection, through Neon's pooler (the host carries a `-pooler`
   * suffix). PgBouncer in transaction mode multiplexes many short-lived
   * serverless connections onto few Postgres backends -- which is why it
   * cannot run DDL or session-level statements. Use DIRECT_URL for those.
   */
  DATABASE_URL: z.string().url(),
  /**
   * Direct connection to the primary compute, bypassing the pooler. Only
   * drizzle-kit uses it, for migrations and `db:push`: DDL through a
   * transaction-mode pooler either fails or silently lands on the wrong
   * backend. Optional -- falls back to DATABASE_URL for plain Postgres, where
   * there is no pooler to bypass.
   */
  DIRECT_URL: z.string().url().optional(),
  /** Port the API binds to. Coerced because process.env values are strings. */
  PORT: z.coerce.number().int().positive().max(65_535).default(3001),
} as const;

export const serverEnv = createEnv({
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
  server: serverSchema,
  shared: sharedSchema,
  skipValidation: Boolean(process.env.SKIP_ENV_VALIDATION),
});

/** Convenience alias consumed by `@repo/db` and `@repo/auth`. */
export const env = serverEnv;

export type ServerEnv = typeof serverEnv;
