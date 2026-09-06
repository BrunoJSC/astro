/**
 * Build-time environment validation.
 *
 * This import is the whole integration: evaluating `@repo/env/server` runs the
 * T3 Env schema, and an invalid value aborts `next build` before anything is
 * emitted. Next compiles this config file itself, so it resolves the workspace
 * package's raw TypeScript without needing `transpilePackages`.
 */
import "@repo/env/server";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Workspace packages ship raw TypeScript -- their `exports` point at
   * `src/*.ts`, with no build step -- so Next has to compile them itself.
   * Without this every import from @repo/* fails at build time with a syntax
   * error on the first type annotation it meets.
   */
  transpilePackages: [
    "@repo/ui",
    "@repo/env",
    "@repo/auth",
    "@repo/db",
    "@repo/server",
  ],

  // Type-safe `<Link href>` and route helpers generated from the App Router.
  // Top-level since Next 16; it was `experimental.typedRoutes` before.
  typedRoutes: true,

  // `argon2` is a native addon reached through @repo/auth; bundling it would
  // break the .node binary resolution, so it stays external on the server.
  serverExternalPackages: ["argon2", "pg"],
  experimental: {
    // `turbopackRustReactCompiler` is not here on purpose: it is a hard error
    // without a top-level `reactCompiler: true`.
    optimizeCss: true,
    useTypeScriptCli: true,
    optimizeServerReact: true,
  },
  cacheComponents: true,
};

export default nextConfig;
