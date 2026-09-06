import { Elysia, t } from "elysia";
import { authPlugin } from "../../plugins/auth";

/**
 * Aggregator for version 1 of the public API.
 *
 * Sub-resources are their own modules and mount here with `.use()`, each
 * carrying its own `model.ts` -- this file stays composition, not handlers.
 * Breaking changes belong in a `/v2` sibling rather than an edit here, since
 * every app compiles against this shape through Eden.
 */
export const v1Module = new Elysia({ name: "module.v1", prefix: "/v1" })
  .use(authPlugin)
  .get(
    "/me",
    ({ status, user }) => {
      if (!user) {
        return status(401, { message: "Not authenticated" as const });
      }

      return {
        email: user.email,
        id: user.id,
        name: user.name,
      };
    },
    {
      detail: {
        description:
          "Returns the session owner, or 401 when no valid session cookie is present.",
        summary: "Current user",
        tags: ["v1"],
      },
      // Both statuses are declared: Eden types the error branch from the 401
      // schema, so a consumer gets `error.value.message` typed, not `unknown`.
      response: {
        200: t.Object({
          email: t.String({ format: "email" }),
          id: t.String(),
          name: t.String(),
        }),
        401: t.Object({
          message: t.Literal("Not authenticated"),
        }),
      },
    }
  );
