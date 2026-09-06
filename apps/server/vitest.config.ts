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
    include: ["tests/integration/**/*.test.ts"],
    name: "@repo/server",
    setupFiles: ["./tests/setup.ts"],
  },
});
