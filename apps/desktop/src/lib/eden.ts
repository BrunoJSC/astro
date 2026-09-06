import { createEdenClient } from "@repo/server/eden";
import { env } from "../env";

/**
 * Typed client against the Elysia API, shared with web and native.
 *
 * The base URL is absolute and always will be. The web app can pass a relative
 * origin because it is served from the same host as the API; a Tauri window is
 * served from `tauri://localhost` (or `http://tauri.localhost` on Windows), an
 * origin the API does not live on, so every request here is cross-origin by
 * construction.
 *
 * Two consequences worth knowing before debugging a failing request:
 *
 *   1. Those origins must be in the server's CORS_ORIGINS. They are not
 *      `http://localhost:1420` -- that is only what Vite serves during
 *      `tauri dev`, and a packaged build never uses it.
 *   2. `credentials: "include"` is set by `createEdenClient`, but a session
 *      cookie set by a different origin is a third-party cookie, and current
 *      webviews block those by default. See `./auth-client`.
 */
export const api = createEdenClient(env.VITE_API_URL);
