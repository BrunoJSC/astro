import { defineConfig } from "vitest/config";

/**
 * Root config for running the whole suite from the repo root
 * (`bunx vitest run`). CI goes through `turbo run test`, which invokes each
 * package's own config instead -- this one exists for local convenience.
 */
export default defineConfig({
  test: {
    projects: ["packages/db", "packages/auth", "apps/server"],
  },
});
