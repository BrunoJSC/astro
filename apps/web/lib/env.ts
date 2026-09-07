import "server-only";

export type { ServerEnv } from "@repo/env/server";
/**
 * The server environment, as `apps/web` is allowed to reach it.
 *
 * `@repo/env/server` holds `DATABASE_URL` and `BETTER_AUTH_SECRET`, and on its
 * own nothing stops a Client Component from importing it. T3 Env's guard is
 * `typeof window`, evaluated once inside `createEnv` -- so during a prerender,
 * where a Client Component runs on the SERVER, the guard sees a server and
 * hands the value over. It is then written into
 * `.next/server/app/<route>.html`, the file every visitor downloads, without
 * ever appearing in a JS chunk.
 *
 * `import "server-only"` is what closes that, and it works because Next treats
 * it as a compiler marker rather than as a module: "Next.js handles
 * `server-only` imports internally. The contents of these packages from NPM
 * are not used." A Client Component reaching this file is a BUILD ERROR.
 *
 * It has to live here rather than in `packages/env`. Outside Next -- Bun,
 * plain Node, drizzle-kit, `bun test` -- the npm package really does execute
 * and throws on import, measured; and `apps/server`, `packages/auth`,
 * `drizzle.config.ts` and this app's own `next.config.ts` all import
 * `@repo/env/server` from exactly there.
 *
 * So: app code imports `@/lib/env`. `next.config.ts` and `instrumentation.ts`
 * keep importing `@repo/env/server` directly, because they run in the build's
 * and the boot's Node process, outside any client graph. `biome.jsonc` makes
 * that split enforceable rather than customary.
 */
export { env, serverEnv } from "@repo/env/server";
