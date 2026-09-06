import { auth } from "@repo/auth/server";
import { Elysia } from "elysia";

/**
 * Hands every `/api/auth/*` request to Better Auth untouched.
 *
 * The original `Request` is forwarded rather than a reconstructed one: Better
 * Auth routes on the full pathname and reads the body itself. `parse: "none"`
 * stops Elysia consuming the stream first, which would leave Better Auth with
 * an empty body on sign-in and sign-up.
 *
 * No TypeBox schema here on purpose -- this module owns none of these shapes;
 * Better Auth defines and documents its own endpoints.
 */
export const authModule = new Elysia({ name: "module.auth" }).all(
  "/api/auth/*",
  ({ request }) => auth.handler(request),
  {
    detail: {
      description:
        "Better Auth handler: sign-up, sign-in, sign-out, session and callbacks.",
      summary: "Authentication endpoints",
      tags: ["Auth"],
    },
    parse: "none",
  }
);
