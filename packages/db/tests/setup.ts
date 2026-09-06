/**
 * Runs before any test module is imported, so `@repo/env/server` sees a valid
 * environment when `@repo/db` pulls it in at import time.
 */
process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-with-at-least-thirty-two-chars";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.NODE_ENV ??= "test";
