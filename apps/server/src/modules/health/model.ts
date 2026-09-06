import { t } from "elysia";

/**
 * The module's contract, kept apart from its handlers.
 *
 * These TypeBox schemas are load-bearing in three places at once: Elysia
 * validates responses against them at runtime, Eden Treaty derives the
 * client's return types from them at compile time, and the OpenAPI document
 * at /docs is generated from them. Editing a schema moves all three together,
 * which is the point of declaring it once.
 */
export const healthModel = {
  health: t.Object({
    status: t.Literal("ok"),
  }),

  ready: t.Object({
    status: t.Literal("ready"),
    timestamp: t.String({ format: "date-time" }),
    uptime: t.Number({ description: "Process uptime in seconds" }),
  }),
} as const;
