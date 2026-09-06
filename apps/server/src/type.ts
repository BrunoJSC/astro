/**
 * The contract, and nothing else.
 *
 * Consumers import from here rather than from `./index` so that pulling in the
 * API's types never pulls in the server itself. `export type` is erased at
 * compile time, so a browser bundle importing this gets zero bytes -- whereas
 * importing `./index` would drag in Elysia, the database client and the
 * server-only environment, and fail at build time in `apps/web`.
 *
 *   import type { App } from "@repo/server/type";
 *   const client = treaty<App>("http://localhost:3001");
 */
export type { App } from "./index";
