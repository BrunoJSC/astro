import { desktopSchema } from "@repo/env/desktop";
import { sharedSchema } from "@repo/env/shared";
import { createEnv } from "@t3-oss/env-core";

/**
 * Validated public environment for the desktop app.
 *
 * Every key is spelled out in `runtimeEnv` rather than spread from
 * `import.meta.env`. Vite replaces these by static text substitution, so
 * `...import.meta.env` compiles to an object that is empty in a production
 * build while type-checking perfectly -- the failure only shows up as a
 * request to `undefined/auth` in a shipped binary.
 *
 * Anything here is readable by anyone who unpacks the app bundle. A desktop
 * build is a directory on the user's disk; there are no secrets in it.
 */
export const env = createEnv({
  client: desktopSchema,
  clientPrefix: "VITE_",
  emptyStringAsUndefined: true,
  runtimeEnv: {
    MODE: import.meta.env.MODE,
    VITE_API_URL: import.meta.env.VITE_API_URL,
  },
  shared: {
    // Vite exposes MODE, not NODE_ENV, and its default values are
    // "development" and "production" -- the same vocabulary `sharedSchema`
    // already speaks, so it is renamed rather than re-described.
    MODE: sharedSchema.NODE_ENV,
  },
  skipValidation: Boolean(import.meta.env.VITE_SKIP_ENV_VALIDATION),
});
