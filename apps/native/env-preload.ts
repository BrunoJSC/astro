import { loadProjectEnv } from "@expo/env";

/**
 * Applies this project's `.env*` files to `process.env`.
 *
 * Exists as its own module purely for ordering. ESM hoists every `import`
 * above the statements in a file, so this cannot be a function call at the top
 * of `app.config.ts` -- it would run after the schema import it is meant to
 * precede. Side-effect imports, on the other hand, execute in source order, so
 * importing this module first does work.
 *
 * It is needed at all because `expo export` evaluates `app.config.ts` BEFORE
 * applying `.env`, while `expo config` applies it first.
 *
 * `mode` is passed explicitly: the loader warns and falls back to only
 * `.env`/`.env.local` when NODE_ENV is unset, which it is on this code path.
 *
 * `process.cwd()` rather than `__dirname`, which does not exist in the ESM
 * scope Expo evaluates this in -- the CLI always runs from the project root.
 */
loadProjectEnv(process.cwd(), {
  mode: process.env.NODE_ENV ?? "development",
  silent: true,
});
