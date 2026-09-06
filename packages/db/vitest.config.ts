import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["src/**"],
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
    environment: "node",
    // Integration tests only. Unit tests live in `src/**/*.test.ts` and are
    // run by `bun test`; keeping the globs disjoint stops the two runners
    // from collecting each other's files.
    include: ["tests/integration/**/*.test.ts"],
    name: "@repo/db",
    setupFiles: ["./tests/setup.ts"],
  },
});
