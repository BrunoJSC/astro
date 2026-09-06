import { env } from "@repo/env/server";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  casing: "snake_case",
  dbCredentials: {
    /**
     * DDL goes to the primary compute directly, never through the pooler.
     *
     * Neon's pooler runs PgBouncer in transaction mode, where each statement
     * may land on a different backend and session-level state does not
     * survive. Migrations depend on both -- advisory locks, `CREATE TYPE`,
     * multi-statement transactions -- so running them pooled fails, or worse,
     * half-applies. The fallback to DATABASE_URL covers plain Postgres, where
     * there is no pooler to bypass.
     */
    url: env.DIRECT_URL ?? env.DATABASE_URL,
  },
  dialect: "postgresql",
  out: "./drizzle",
  schema: "./src/schema/index.ts",
  strict: true,
  verbose: true,
});
