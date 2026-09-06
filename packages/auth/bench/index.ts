// The auth instance reads server-only env at import time; seed it before
// importing so the benchmark measures the parameters actually configured in
// `src/server.ts` rather than a copy that can drift away from them.
process.env.DATABASE_URL ??=
  "postgres://postgres:postgres@localhost:5432/bench";
process.env.BETTER_AUTH_SECRET ??=
  "bench-secret-with-at-least-thirty-two-chars";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";

const argon2 = (await import("argon2")).default;
const { ARGON2_OPTIONS } = await import("../src/server");
const { bench, run, summary } = await import("mitata");

/**
 * Login latency, end to end. Argon2id is deliberately slow -- these numbers
 * are the budget every sign-in and sign-up pays, and the input to any decision
 * about raising `memoryCost` / `timeCost` (see ../src/server).
 */
const PASSWORD = "correct horse battery staple";
const HASH = await argon2.hash(PASSWORD, ARGON2_OPTIONS);

summary(() => {
  bench("hash (sign-up)", async () => {
    await argon2.hash(PASSWORD, ARGON2_OPTIONS);
  });

  bench("verify - correct (sign-in)", async () => {
    await argon2.verify(HASH, PASSWORD);
  });

  bench("verify - wrong", async () => {
    await argon2.verify(HASH, "wrong");
  });
});

await run();
