import { auth } from "@repo/auth/server";
import { Elysia } from "elysia";

/**
 * Resolves the Better Auth session from the request cookies and puts
 * `user` / `session` on the handler context.
 *
 * `name` is what makes this a plugin rather than a copy: Elysia deduplicates
 * by name, so mounting it from three different modules registers the lifecycle
 * hook once, not three times.
 *
 * `as: "scoped"` limits the derive to whoever mounts it and their children --
 * modules that never opt in do not pay for a session lookup per request.
 */
export const authPlugin = new Elysia({ name: "plugin.auth" }).derive(
  { as: "scoped" },
  async ({ request }) => {
    const result = await auth.api.getSession({ headers: request.headers });

    return {
      session: result?.session ?? null,
      user: result?.user ?? null,
    };
  }
);
