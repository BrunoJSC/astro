process.env.DATABASE_URL ??=
  "postgres://postgres:postgres@localhost:5432/bench";
process.env.BETTER_AUTH_SECRET ??=
  "bench-secret-with-at-least-thirty-two-chars";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";

const { bench, run, summary } = await import("mitata");
const { app } = await import("../src/index");

/**
 * In-process request throughput: `app.handle()` exercises routing, schema
 * validation and the handler chain without binding a socket, so the numbers
 * isolate framework overhead from the network stack.
 */
const request = (path: string) => new Request(`http://localhost${path}`);

summary(() => {
  bench("GET /health", async () => {
    await app.handle(request("/health"));
  });

  bench("GET /health/ready", async () => {
    await app.handle(request("/health/ready"));
  });

  bench("GET /v1/me (401, session lookup)", async () => {
    await app.handle(request("/v1/me"));
  });

  bench("GET /nope (404)", async () => {
    await app.handle(request("/nope"));
  });
});

await run();
