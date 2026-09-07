/**
 * What `@repo/env/server` resolves to inside a client bundle.
 *
 * The server schema holds `DATABASE_URL` and `BETTER_AUTH_SECRET`. T3 Env's own
 * guard is `typeof window`, which is evaluated once inside `createEnv` -- so it
 * protects a browser and nothing else. Measured: a Next Client Component
 * importing `./server` COMPILES, and during prerender it runs on the server,
 * where the guard sees a server and hands the value over. The secret is then
 * baked into `.next/server/app/<route>.html`, the file every visitor
 * downloads, without ever appearing in a JS chunk.
 *
 * This module is what closes that. `package.json` maps the `browser` export
 * condition here, so any bundler building for a browser -- Next's client
 * graph, Vite for the Electron renderer, Metro for React Native -- resolves
 * this file instead of the schema, and the import fails while the build is
 * still running.
 *
 * `server-only` was the obvious alternative and does not work here. It stays
 * silent only under the `react-server` condition, which only Next's RSC
 * compiler sets; under Bun and plain Node it throws on import. Measured. Since
 * `apps/server`, `packages/auth`, `drizzle.config.ts` and even
 * `apps/web/next.config.ts` all import `./server` outside that condition, it
 * would have taken the API, the migrations and the web build down with it.
 */

const MESSAGE =
  "@repo/env/server was imported into a client bundle. It holds DATABASE_URL " +
  "and BETTER_AUTH_SECRET, so this is a build error rather than a runtime " +
  "one. Use @repo/env/client (NEXT_PUBLIC_), @repo/env/native " +
  "(EXPO_PUBLIC_) or @repo/env/desktop (VITE_) instead.";

throw new Error(MESSAGE);

// Declared so a bundler that reaches for the named exports before evaluating
// the module reports the missing import rather than a confusing type error.
export const serverEnv = undefined as never;
export const env = undefined as never;
export const serverSchema = undefined as never;
export type ServerEnv = never;
