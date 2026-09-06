/**
 * Types only.
 *
 * Value exports are deliberately absent: re-exporting anything from
 * `./server` would execute its `createEnv` call, and pulling that into a
 * client bundle trips T3 Env's server guard. `export type` is erased by
 * `verbatimModuleSyntax`, so this module emits no runtime import at all.
 *
 * Import the validated objects from the explicit entry points:
 *   import { env } from "@repo/env/server";
 *   import { clientEnv } from "@repo/env/client";
 */

export type { ClientEnv } from "./client";
export type { NativeEnv } from "./native";
export type { ServerEnv } from "./server";
export type { SharedEnv } from "./shared";
