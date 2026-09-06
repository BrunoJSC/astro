import { Elysia } from "elysia";
import { healthModel } from "./model";

/**
 * Liveness and readiness probes.
 *
 * Paths are spelled out rather than using `prefix: "/health"` with a `"/"`
 * route: that combination registers the OpenAPI path as "/health/", and the
 * trailing slash surfaces in the published docs and in Eden's client shape.
 */
export const healthModule = new Elysia({ name: "module.health" })
  .get("/health", () => ({ status: "ok" as const }), {
    detail: {
      description: "Liveness probe. Answers as soon as the process can serve.",
      summary: "Health check",
      tags: ["Health"],
    },
    response: { 200: healthModel.health },
  })
  .get(
    "/health/ready",
    () => ({
      status: "ready" as const,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    }),
    {
      detail: {
        description:
          "Readiness probe with process uptime, for rollout gating and dashboards.",
        summary: "Readiness check",
        tags: ["Health"],
      },
      response: { 200: healthModel.ready },
    }
  );
