import { cors } from "@elysiajs/cors";
import { env } from "@repo/env/server";
import { Elysia } from "elysia";
import { authModule } from "./modules/auth";
import { gatewayModule, shutdownGateway } from "./modules/gateway";
import { healthModule } from "./modules/health";
import { v1Module } from "./modules/v1";
import { closeRealtime } from "./plugins/kv";
import { swaggerPlugin } from "./plugins/swagger";

/**
 * Root instance: infrastructure first, then domain modules.
 *
 * Nothing is defined inline here -- every route lives in a named module under
 * `./modules`, and every cross-cutting concern in a named plugin under
 * `./plugins`. That is what lets a test mount one module in isolation, and
 * what keeps Elysia's plugin deduplication working (it keys on `name`).
 */
export const app = new Elysia({ name: "server" })
  .use(
    cors({
      // Must be listed explicitly: left unset, the plugin emits the literal
      // string "undefined" as the Access-Control-Allow-Headers value.
      allowedHeaders: ["Content-Type", "Authorization"],
      // Parsed from CORS_ORIGINS by @repo/env; never a wildcard, because
      // `credentials: true` and `*` are mutually exclusive per the CORS spec
      // and browsers reject the combination outright.
      credentials: true,
      exposeHeaders: ["Content-Type"],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      origin: env.CORS_ORIGINS,
    })
  )
  .use(swaggerPlugin)
  .use(healthModule)
  .use(authModule)
  .use(gatewayModule)
  .use(v1Module);

if (import.meta.main) {
  app.listen(env.PORT, ({ hostname, port }) => {
    process.stdout.write(
      `server ready on http://${hostname}:${port} (docs: /docs, gateway: /gateway)\n`
    );
  });

  /*
   * Presence has a 60-second TTL, so a process that exits without cleaning up
   * leaves every one of its users looking online for a full minute -- on every
   * deploy, for every client that node was holding. Dropping them here turns a
   * minute of stale presence into none.
   *
   * SIGINT as well as SIGTERM: the first is Ctrl-C in development, and a
   * developer restarting the server should not leave ghosts behind either.
   */
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, async () => {
      try {
        await shutdownGateway();
        await closeRealtime();
      } finally {
        process.exit(0);
      }
    });
  }
}

export type App = typeof app;
