import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as realAuth from "@repo/auth/server";
import { Elysia } from "elysia";
import { fakeRealtime, TestClient, waitFor } from "./harness";

/**
 * The gateway, over a real WebSocket, against a real Elysia server.
 *
 * What this covers that nothing else does: the upgrade. Every claim about it in
 * this repository came from reading Elysia's Bun adapter source, not from
 * running it -- that the `.ws()` route runs the full plugin lifecycle, that
 * `authPlugin`'s derive lands on `ws.data`, that the TypeBox `body` schema
 * rejects a frame before a handler sees it, that `ws.close(4001)` reaches the
 * client with that code.
 *
 * Mocks are SPREADS of the real modules, never replacements. `mock.module` in
 * Bun is process-global, so a bare replacement here would also apply to every
 * other test file in the run.
 *
 * `bun test`, not vitest: vitest runs under Node here (verified), and
 * `app.listen()` needs `Bun.serve`.
 */

const USER = { id: "01931f4c-8d2a-7000-8000-000000000001", name: "ana" };
const GUILD = "01931f4c-8d2a-7000-8000-000000000002";
const CHANNEL = "01931f4c-8d2a-7000-8000-000000000003";

/** Steered per test. */
let session: { session: { id: string }; user: typeof USER } | null = null;
let authorised = true;

mock.module("@repo/auth/server", () => ({
  ...realAuth,
  auth: {
    ...realAuth.auth,
    api: {
      ...realAuth.auth.api,
      getSession: () => Promise.resolve(session),
    },
  },
}));

mock.module("../../src/modules/gateway/authorize", () => ({
  canAccess: () => Promise.resolve(authorised),
  canAccessChannel: () => Promise.resolve(authorised),
  canAccessGuild: () => Promise.resolve(authorised),
  forgetMemberships: () => undefined,
  guildIdsFor: () => Promise.resolve([GUILD]),
}));

const { calls, realtime, sockets } = fakeRealtime();

mock.module("../../src/plugins/kv", () => ({
  closeRealtime: () => Promise.resolve(),
  getRealtime: () => Promise.resolve(realtime),
  kvPlugin: new Elysia({ name: "plugin.kv" }),
  NODE_ID: realtime.nodeId,
}));

const { gatewayModule, shutdownGateway } = await import(
  "../../src/modules/gateway"
);

// Port 0 lets the OS pick a free one. A fixed port fails the suite whenever a
// dev server is already running -- which is exactly when it gets run.
const server = new Elysia().use(gatewayModule).listen(0);
const GATEWAY = `ws://localhost:${server.server?.port}/gateway`;

beforeEach(async () => {
  /*
   * Wait for the previous test's sockets to finish closing before clearing the
   * call log. A `close()` resolves on the client while the server's handler is
   * still running, so without this a disconnect from one test lands in the
   * next one's recording -- which is how `presenceDrop` was seen twice.
   */
  await waitFor(() => sockets.size === 0).catch(() => undefined);

  session = { session: { id: "s1" }, user: USER };
  authorised = true;
  calls.length = 0;
});

afterAll(async () => {
  await shutdownGateway();
  server.stop();
});

async function connect(protocols?: string[]): Promise<TestClient> {
  const client = new TestClient(GATEWAY, protocols);
  await client.open();
  return client;
}

/** Connects and consumes the `ready` frame, which every test would skip past. */
async function ready(): Promise<TestClient> {
  const client = await connect();
  await client.next();
  return client;
}

const named = (name: string) => calls.filter((call) => call.name === name);

describe("upgrade and authentication", () => {
  it("derives the session on the upgrade and sends ready", async () => {
    /*
     * The claim this proves. Elysia registers `.ws()` as an ordinary route, so
     * `authPlugin`'s derive was expected to run on the upgrade and land on
     * `ws.data`. That was read out of the adapter's source; this executes it.
     */
    const client = await connect();
    const frame = await client.next();

    expect(frame.op).toBe("ready");
    expect(frame.userId).toBe(USER.id);
    expect(typeof frame.socketId).toBe("string");
    expect(frame.heartbeatIntervalMs).toBeGreaterThan(0);

    client.close();
  });

  it("closes with 4001 when there is no session", async () => {
    session = null;
    const client = await connect();

    expect(await client.next()).toMatchObject({
      code: "unauthorised",
      op: "error",
    });
    expect((await client.closed).code).toBe(4001);
  });

  it("registers presence for the socket that connected", async () => {
    const client = await ready();

    expect(named("presenceTouch")).toHaveLength(1);
    expect(sockets.size).toBe(1);

    client.close();
  });

  it("echoes the bearer subprotocol back to the client", async () => {
    // A browser fails the connection when the server selects a protocol that
    // was not offered, so the echo is not cosmetic.
    // base64url, as `apps/desktop` sends it: a raw Better Auth token ends in
    // `=` and the WebSocket constructor refuses it outright.
    const client = await connect(["bearer", "dG9rZW4tZm9yLXRoZS10ZXN0"]);
    await client.next();

    expect(client.protocol).toBe("bearer");
    client.close();
  });

  it("selects no protocol when none was offered", async () => {
    const client = await ready();
    expect(client.protocol).toBe("");
    client.close();
  });
});

describe("frame protocol", () => {
  it("answers a ping with a pong and refreshes presence", async () => {
    const client = await ready();
    calls.length = 0;

    client.send({ op: "ping" });
    expect(await client.next()).toEqual({ op: "pong" });
    expect(named("presenceTouch")).toHaveLength(1);

    client.close();
  });

  it("confirms a subscribe the user is allowed", async () => {
    const client = await ready();

    client.send({ id: GUILD, op: "subscribe", scope: "guild" });
    expect(await client.next()).toEqual({
      id: GUILD,
      op: "subscribed",
      scope: "guild",
    });

    client.close();
  });

  it("refuses a subscribe the user is not allowed", async () => {
    authorised = false;
    const client = await ready();

    client.send({ id: GUILD, op: "subscribe", scope: "guild" });
    expect(await client.next()).toMatchObject({
      code: "forbidden",
      op: "error",
    });

    client.close();
  });

  it("delivers an event published to a subscribed topic", async () => {
    const client = await ready();

    client.send({ id: CHANNEL, op: "subscribe", scope: "channel" });
    await client.next();

    // Straight into the registry, as a message from another node arrives.
    realtime.subscriber.emit(
      "message",
      `events:channel:{${CHANNEL}}`,
      JSON.stringify({
        messageId: "m1",
        origin: "another-node",
        ts: Date.now(),
        type: "message.deleted",
      })
    );

    expect(await client.next()).toMatchObject({
      op: "event",
      scope: "channel",
      topic: `channel:${CHANNEL}`,
    });

    client.close();
  });

  it("does not deliver an event this node published itself", async () => {
    const client = await ready();
    client.send({ id: CHANNEL, op: "subscribe", scope: "channel" });
    await client.next();

    realtime.subscriber.emit(
      "message",
      `events:channel:{${CHANNEL}}`,
      JSON.stringify({
        messageId: "m1",
        origin: realtime.nodeId,
        ts: Date.now(),
        type: "message.deleted",
      })
    );

    // Nothing should arrive. A pong sent afterwards is the marker that the
    // socket is alive and simply had nothing to deliver in between.
    client.send({ op: "ping" });
    expect(await client.next()).toEqual({ op: "pong" });

    client.close();
  });

  it("publishes a typing indicator to the channel", async () => {
    const client = await ready();
    calls.length = 0;

    client.send({ channelId: CHANNEL, op: "typing.start" });
    expect(await client.next()).toMatchObject({
      channelId: CHANNEL,
      op: "typing",
    });

    expect(named("typingStart")).toHaveLength(1);
    expect(named("publish")).toHaveLength(1);

    client.close();
  });

  it("throttles a second typing frame for the same channel", async () => {
    const client = await ready();

    client.send({ channelId: CHANNEL, op: "typing.start" });
    await client.next();
    calls.length = 0;

    // A client sends this on every keystroke; without the throttle each one
    // becomes a publish that fans out to every socket in the channel.
    client.send({ channelId: CHANNEL, op: "typing.start" });
    client.send({ op: "ping" });
    expect(await client.next()).toEqual({ op: "pong" });

    expect(named("publish")).toHaveLength(0);

    client.close();
  });
});

describe("schema validation", () => {
  it("rejects an unknown op before any handler runs", async () => {
    const client = await ready();
    calls.length = 0;

    client.send({ op: "definitely.not.a.frame" });

    // Elysia answers a schema failure with a validation report rather than
    // silence, which is what lets a client tell a bug from a dropped frame.
    const frame = await client.next();
    expect(frame.type).toBe("validation");
    expect(frame.on).toBe("message");
    expect(frame.found).toEqual({ op: "definitely.not.a.frame" });
    // The point of the schema: nothing reached Redis.
    expect(calls).toHaveLength(0);

    client.close();
  });

  it("rejects a known op carrying a malformed field", async () => {
    const client = await ready();
    calls.length = 0;

    // `channelId` must be a uuid. Without the schema this reaches Redis and
    // writes junk into a channel's typing index.
    client.send({ channelId: "not-a-uuid", op: "typing.start" });

    const frame = await client.next();
    expect(frame.type).toBe("validation");
    expect(calls).toHaveLength(0);

    client.close();
  });

  it("rejects a payload that is not JSON, and stays connected", async () => {
    const client = await ready();

    client.sendRaw("{{{ not json");
    const frame = await client.next();
    expect(frame.type).toBe("validation");

    // The connection has to survive it -- one malformed frame from one buggy
    // client must not drop that client's whole session.
    client.send({ op: "ping" });
    expect(await client.next()).toEqual({ op: "pong" });

    client.close();
  });
});

describe("presence across devices", () => {
  it("counts a second socket without a second announcement", async () => {
    const first = await ready();
    const announcements = named("publish").length;

    const second = await ready();

    expect(sockets.size).toBe(2);
    /*
     * Only the FIRST connection is a transition. Announcing the second would
     * light up "came online" for everyone watching, every time the user opened
     * a tab.
     */
    expect(named("publish")).toHaveLength(announcements);

    first.close();
    second.close();
  });

  it("drops the socket on disconnect", async () => {
    const client = await ready();
    expect(sockets.size).toBe(1);

    client.close();
    await waitFor(() => named("presenceDrop").length > 0);

    expect(named("presenceDrop")).toHaveLength(1);
    expect(sockets.size).toBe(0);
  });
});
