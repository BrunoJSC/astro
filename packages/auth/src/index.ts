/**
 * Types only -- `./server` reads server-only env and `./client` is
 * browser-facing, so neither is safe to pull in unconditionally. Import the
 * explicit entry point you need:
 *   import { auth } from "@repo/auth/server";
 *   import { authClient } from "@repo/auth/client";
 */

export type { AuthClient } from "./client";
export type { Auth, Session } from "./server";
