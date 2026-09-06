import "./env-preload.ts";
import "@repo/env/native";
import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Build-time environment validation.
 *
 * `app.json` stays the source of static config; this file only wraps it. The
 * two side-effect imports above are ordered on purpose: the first applies the
 * `.env` files, the second runs the T3 Env schema against them, so a missing
 * or malformed EXPO_PUBLIC_API_URL aborts `expo export` / `expo start` instead
 * of shipping a bundle that crashes on launch. Metro validates nothing -- it
 * inlines whatever it finds, `undefined` included.
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? "Astro",
  slug: config.slug ?? "astro",
});
