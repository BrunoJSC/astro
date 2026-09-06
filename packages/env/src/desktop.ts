import { z } from "zod";

/**
 * Public variables for the Tauri desktop app -- the SCHEMA only.
 *
 * Unlike `./client` and `./native`, this module does not call `createEnv`, and
 * the reason is Vite. Next and Metro read `process.env.*`, which is a portable
 * expression this package can evaluate on their behalf. Vite does not: it
 * inlines `import.meta.env.VITE_*` by literal textual substitution at build
 * time, so the expression has to appear, spelled out, in a file Vite itself
 * compiles. Written here it would survive as-is and read undefined in a
 * production build -- silently, since an unreplaced `import.meta.env` is a
 * valid empty object.
 *
 * So the app owns the `createEnv` call and lists the keys literally; this
 * module owns their shape, which is what keeps the four apps' contracts in one
 * place. `./shared` is a schema map for the same kind of reason.
 *
 * See `apps/desktop/src/env.ts`.
 */
export const desktopSchema = {
  VITE_API_URL: z.string().url(),
} as const;

export type DesktopEnv = {
  [K in keyof typeof desktopSchema]: z.infer<(typeof desktopSchema)[K]>;
};
