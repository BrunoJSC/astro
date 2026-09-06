import { swagger } from "@elysiajs/swagger";
import { Elysia } from "elysia";

/**
 * OpenAPI document plus the Scalar reference UI at /docs.
 *
 * The document is not written by hand: it is derived from the TypeBox schemas
 * each module declares, which is the same source Eden Treaty reads for the
 * client types. One definition, so the published docs cannot drift from the
 * contract the apps compile against.
 */
export const swaggerPlugin = new Elysia({ name: "plugin.swagger" }).use(
  swagger({
    documentation: {
      info: {
        description:
          "Typed API surface consumed by web, native and desktop through Eden Treaty.",
        title: "Astro API",
        version: "0.0.0",
      },
      tags: [
        { description: "Liveness and readiness probes", name: "Health" },
        { description: "Better Auth endpoints", name: "Auth" },
        { description: "Version 1 of the public API", name: "v1" },
      ],
    },
    path: "/docs",
    provider: "scalar",
  })
);
