import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  announceSkip,
  cookieFrom,
  type Loaded,
  loadAuth,
  newEmail,
  PASSWORD,
  reachable,
  stopProxy,
} from "./helpers";

/** UUIDv7: version nibble 7 in the third group. */
const UUID_V7_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-7/;

const B64_PLUS = /\+/g;
const B64_SLASH = /\//g;
const B64_PADDING = /[=]+$/;
const B64_DASH = /-/g;
const B64_UNDERSCORE = /_/g;

/**
 * Sign-up and sign-in, against a real database.
 *
 * `tests/integration/` proves argon2 hashes and verifies, and that the handler
 * is shaped correctly. Neither creates a user. Everything below the API surface
 * -- that the adapter writes the rows, that the hash the instance is configured
 * with is the one that lands in `account.password`, that a session survives a
 * round trip -- had never run.
 */

const available = await reachable();
if (!available) {
  announceSkip("auth/credentials");
}

/*
 * One teardown for the whole file. Inside a suite it fires after THAT suite
 * and takes the tunnel away from the ones still to run -- which shows up as
 * "Connection terminated unexpectedly" three tests later.
 */
afterAll(() => {
  stopProxy();
});

/**
 * OWASP's parameters, as configured in `src/server.ts`.
 *
 * Asserted field by field rather than as one prefix string: argon2 emits them
 * in `m,p,t` order, not the `m,t,p` the configuration object lists, and an
 * exact-prefix match fails for a reason that has nothing to do with the
 * parameters being wrong.
 */
/** RFC 7230's `token` charset, which a WebSocket subprotocol must satisfy. */
const SUBPROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const ARGON2ID_PARAMS = ["$argon2id$", "v=19", "m=19456", "t=2", "p=1"];

/**
 * For the hooks that do real setup work.
 *
 * Generous rather than tuned: it is not measuring anything, it is only there
 * so a slow machine fails the assertion it was going to fail anyway instead of
 * failing the hook. Every hook below also signs a user up, and argon2id is
 * deliberately expensive.
 */
const SETUP_TIMEOUT_MS = 120_000;

describe.skipIf(!available)("sign up", () => {
  let auth: Loaded["auth"];
  let database: Loaded["db"];

  /*
   * An explicit timeout, because the default five seconds is a bet on the
   * machine. This hook starts the WebSocket tunnel, creates the database if it
   * is absent and applies @repo/db's whole migration; measured at 5,830ms
   * during a parallel `turbo run test`, where it timed out and -- since turbo
   * SIGINTs the sibling tasks -- was reported as three other packages failing.
   */
  beforeAll(async () => {
    ({ auth, db: database } = await loadAuth());
  }, SETUP_TIMEOUT_MS);

  it("creates the user and the credential account", async () => {
    const email = newEmail();
    const response = await auth.api.signUpEmail({
      asResponse: true,
      body: { email, name: "Ana", password: PASSWORD },
    });

    expect(response.status).toBe(200);

    const [user] = await database.db
      .select()
      .from(database.schema.user)
      .where(database.eq(database.schema.user.email, email));

    expect(user?.name).toBe("Ana");
    // UUIDv7 from `advanced.database.generateId`, not Better Auth's own id.
    expect(user?.id).toMatch(UUID_V7_PREFIX);
  });

  it("stores an argon2id hash with the configured parameters", async () => {
    /*
     * The assertion that ties the configuration to the database. Better Auth
     * falls back to its own scrypt when no hasher is supplied, and the
     * difference is invisible from the API -- both sign in fine. The only
     * place it shows is the stored string.
     */
    const email = newEmail();
    await auth.api.signUpEmail({
      body: { email, name: "Ana", password: PASSWORD },
    });

    const [user] = await database.db
      .select()
      .from(database.schema.user)
      .where(database.eq(database.schema.user.email, email));
    const [account] = await database.db
      .select()
      .from(database.schema.account)
      .where(database.eq(database.schema.account.userId, user?.id ?? ""));

    for (const part of ARGON2ID_PARAMS) {
      expect(account?.password).toContain(part);
    }
    // The plaintext must not survive anywhere in the row.
    expect(account?.password).not.toContain(PASSWORD);
  });

  it("refuses a second account on the same email", async () => {
    const email = newEmail();
    const signUp = () =>
      auth.api.signUpEmail({
        asResponse: true,
        body: { email, name: "Ana", password: PASSWORD },
      });

    expect((await signUp()).status).toBe(200);
    expect((await signUp()).status).toBeGreaterThanOrEqual(400);
  });
});

describe.skipIf(!available)("sign in", () => {
  let auth: Loaded["auth"];
  let database: Loaded["db"];
  const email = newEmail();

  beforeAll(async () => {
    ({ auth, db: database } = await loadAuth());
    await auth.api.signUpEmail({
      body: { email, name: "Ana", password: PASSWORD },
    });
  }, SETUP_TIMEOUT_MS);

  it("accepts the right password", async () => {
    const response = await auth.api.signInEmail({
      asResponse: true,
      body: { email, password: PASSWORD },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("session");
  });

  it("rejects the wrong one", async () => {
    const response = await auth.api.signInEmail({
      asResponse: true,
      body: { email, password: "not-the-password" },
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects an email that was never registered", async () => {
    const response = await auth.api.signInEmail({
      asResponse: true,
      body: { email: newEmail(), password: PASSWORD },
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("returns a session the cookie can retrieve", async () => {
    const signIn = await auth.api.signInEmail({
      asResponse: true,
      body: { email, password: PASSWORD },
    });

    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookieFrom(signIn.headers) }),
    });

    expect(session?.user.email).toBe(email);
    expect(session?.session.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("answers with no session when there is no cookie", async () => {
    expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();
  });

  it("writes the session row the adapter is responsible for", async () => {
    const signIn = await auth.api.signInEmail({
      asResponse: true,
      body: { email, password: PASSWORD },
    });
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookieFrom(signIn.headers) }),
    });

    const [row] = await database.db
      .select()
      .from(database.schema.session)
      .where(
        database.eq(database.schema.session.id, session?.session.id ?? "")
      );

    expect(row?.userId).toBe(session?.user.id ?? "");
  });
});

describe.skipIf(!available)("bearer tokens", () => {
  let auth: Loaded["auth"];
  const email = newEmail();

  beforeAll(async () => {
    ({ auth } = await loadAuth());
    await auth.api.signUpEmail({
      body: { email, name: "Ana", password: PASSWORD },
    });
  }, SETUP_TIMEOUT_MS);

  it("returns a token on sign-in", async () => {
    /*
     * The desktop client's whole session story. A packaged Electron renderer
     * loads from `file://`, whose origin is opaque, so the API's cookie is
     * third-party and blocked -- the token is what replaces it.
     */
    const response = await auth.api.signInEmail({
      asResponse: true,
      body: { email, password: PASSWORD },
    });

    expect(response.headers.get("set-auth-token")).toBeTruthy();
  });

  it("accepts that token as Authorization, with no cookie at all", async () => {
    const signIn = await auth.api.signInEmail({
      asResponse: true,
      body: { email, password: PASSWORD },
    });
    const token = signIn.headers.get("set-auth-token") ?? "";

    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });

    expect(session?.user.email).toBe(email);
  });

  it("rejects a token that was never issued", async () => {
    const session = await auth.api.getSession({
      headers: new Headers({ authorization: "Bearer not-a-real-token" }),
    });

    expect(session).toBeNull();
  });

  it("issues a token that CANNOT travel as a subprotocol unencoded", async () => {
    /*
     * The bug this found, and the reason `apps/desktop` base64url-encodes.
     *
     * A subprotocol is an RFC 7230 `token`, whose charset excludes `=`. A
     * Better Auth token is padded base64, so it ends in one -- and the browser
     * refuses to build the socket at all: `new WebSocket(url, ["bearer",
     * "abc="])` throws `SyntaxError: Wrong protocol`. Every unit test on both
     * sides used a fabricated token that happened to fit, so nothing caught it
     * until a real one was put through the real charset.
     */
    const signIn = await auth.api.signInEmail({
      asResponse: true,
      body: { email, password: PASSWORD },
    });
    const token = signIn.headers.get("set-auth-token") ?? "";

    expect(token).not.toMatch(SUBPROTOCOL_TOKEN);

    // Encoded, it fits -- which is what the desktop client actually sends.
    const encoded = btoa(token)
      .replace(B64_PLUS, "-")
      .replace(B64_SLASH, "_")
      .replace(B64_PADDING, "");
    expect(encoded).toMatch(SUBPROTOCOL_TOKEN);
    expect(
      atob(encoded.replace(B64_DASH, "+").replace(B64_UNDERSCORE, "/"))
    ).toBe(token);
  });
});
