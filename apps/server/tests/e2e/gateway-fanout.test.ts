import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { connect } from "node:net";
import {
  createKvClient,
  createKvSubscriber,
  type KvClient,
  publishEvent,
} from "@repo/kv";
import type { Redis } from "ioredis";
import {
  GatewayRegistry,
  type GatewaySocket,
} from "../../src/modules/gateway/registry";
import { waitFor } from "./harness";

/**
 * Cross-node fan-out, against a real Redis.
 *
 * This is the check that cannot be faked and cannot be done with one node. With
 * a single process, an `origin` filter that drops every event and one that
 * drops none are indistinguishable, because every event is local -- the two
 * opposite bugs look identical. Two registries with different origins, sharing
 * one Redis, is the smallest arrangement where the difference is visible.
 *
 * It stands in for two server processes rather than replacing that check. The
 * HTTP and WebSocket layers are covered by `gateway.test.ts`; what is exercised
 * here is the part underneath — real `PUBLISH`, real `SUBSCRIBE`, real
 * delivery across connections.
 *
 * SKIPPED when no Redis answers. That is the normal outcome on a machine
 * without Docker; run `packages/kv`'s `kv:up` first, or set REDIS_URL.
 */

/** `redis://` is not a scheme `URL` parses hosts from; swap it for one. */
const REDIS_SCHEME = /^redis/;
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const GUILD = "01931f4c-8d2a-7000-8000-0000000000f1";
const CHANNEL = "01931f4c-8d2a-7000-8000-0000000000f2";

/**
 * A plain TCP probe, not an ioredis connection.
 *
 * Asking ioredis costs seconds even with retries disabled: `connect()` waits
 * out its timeout, and on macOS `localhost` resolves to both ::1 and
 * 127.0.0.1, so the attempt is made twice. This is a yes/no question about a
 * listening port, and a socket answers it in milliseconds.
 */
function redisReachable(): Promise<boolean> {
  const { hostname, port } = new URL(REDIS_URL.replace(REDIS_SCHEME, "http"));

  return new Promise((resolve) => {
    const socket = connect({
      host: hostname || "127.0.0.1",
      port: Number(port) || 6379,
    });

    const finish = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

const available = await redisReachable();

if (!available) {
  process.stderr.write(
    `\n[gateway-fanout] skipped: no Redis at ${REDIS_URL}.\n` +
      "  cd packages/kv && bun run kv:up\n\n"
  );
}

/** A socket that records what the registry delivered to it. */
function recordingSocket(id: string, userId: string) {
  const received: { op: string; topic: string }[] = [];
  const socket: GatewaySocket = {
    id,
    send: (payload) => received.push(JSON.parse(payload)),
    userId,
  };
  return { received, socket };
}

describe.skipIf(!available)("cross-node fan-out", () => {
  let commandsA: KvClient;
  let commandsB: KvClient;
  let subscriberA: Redis;
  let subscriberB: Redis;
  let nodeA: GatewayRegistry;
  let nodeB: GatewayRegistry;

  beforeAll(async () => {
    // Two command connections and two subscriber connections. The roles are
    // split because their `enableOfflineQueue` settings are opposites -- see
    // `createKvSubscriber` -- not because RESP3 forbids sharing one.
    commandsA = createKvClient({ url: REDIS_URL });
    commandsB = createKvClient({ url: REDIS_URL });
    await Promise.all([commandsA.connect(), commandsB.connect()]);

    subscriberA = createKvSubscriber(commandsA);
    subscriberB = createKvSubscriber(commandsB);
    await Promise.all([subscriberA.connect(), subscriberB.connect()]);

    nodeA = new GatewayRegistry(subscriberA, { origin: "node-a" });
    nodeB = new GatewayRegistry(subscriberB, { origin: "node-b" });
  });

  afterAll(async () => {
    await Promise.allSettled([nodeA?.close(), nodeB?.close()]);
    await Promise.allSettled([
      subscriberA?.quit(),
      subscriberB?.quit(),
      commandsA?.quit(),
      commandsB?.quit(),
    ]);
  });

  it("delivers an event published on one node to a socket on the other", async () => {
    const a = recordingSocket("a1", "user-a");
    const b = recordingSocket("b1", "user-b");

    await nodeA.add(a.socket);
    await nodeB.add(b.socket);
    await nodeA.join(a.socket, "guild", GUILD);
    await nodeB.join(b.socket, "guild", GUILD);

    await publishEvent(commandsA, "guild", GUILD, {
      memberId: "someone",
      origin: "node-a",
      ts: Date.now(),
      type: "member.joined",
    });

    await waitFor(() => b.received.length > 0);

    expect(b.received).toHaveLength(1);
    expect(b.received[0]).toMatchObject({
      op: "event",
      topic: `guild:${GUILD}`,
    });

    /*
     * And the other half, which is the one a single node cannot show: node A
     * published it and is also subscribed, so without the origin filter its own
     * socket receives a duplicate of an event it already handled locally.
     */
    expect(a.received).toHaveLength(0);

    await nodeA.remove(a.socket);
    await nodeB.remove(b.socket);
  });

  it("reaches every socket on the receiving node exactly once", async () => {
    // Two sockets on node B share one Redis subscription. The bug refcounting
    // prevents is duplicate DELIVERY: each `subscribeEvents` call adds another
    // listener on the shared connection.
    const a = recordingSocket("a2", "user-a");
    const first = recordingSocket("b2", "user-b");
    const second = recordingSocket("b3", "user-c");

    await nodeA.add(a.socket);
    await nodeB.add(first.socket);
    await nodeB.add(second.socket);
    await nodeB.join(first.socket, "channel", CHANNEL);
    await nodeB.join(second.socket, "channel", CHANNEL);

    await publishEvent(commandsA, "channel", CHANNEL, {
      messageId: "m1",
      origin: "node-a",
      ts: Date.now(),
      type: "message.deleted",
    });

    await waitFor(
      () => first.received.length > 0 && second.received.length > 0
    );
    // Give a duplicate time to arrive, if the refcount were broken.
    await Bun.sleep(150);

    expect(first.received).toHaveLength(1);
    expect(second.received).toHaveLength(1);

    await nodeA.remove(a.socket);
    await nodeB.remove(first.socket);
    await nodeB.remove(second.socket);
  });

  it("stops delivering after the last subscriber leaves", async () => {
    const b = recordingSocket("b4", "user-b");
    await nodeB.add(b.socket);
    await nodeB.join(b.socket, "guild", GUILD);
    await nodeB.leave(b.socket, "guild", GUILD);

    await publishEvent(commandsA, "guild", GUILD, {
      memberId: "someone",
      origin: "node-a",
      ts: Date.now(),
      type: "member.left",
    });
    await Bun.sleep(200);

    // The user's own private topic is still joined, so an empty array here
    // means the guild subscription really went away rather than the socket
    // having been torn down.
    expect(b.received).toHaveLength(0);

    await nodeB.remove(b.socket);
  });

  it("routes a private event only to that user's node", async () => {
    const a = recordingSocket("a5", "user-alone");
    const b = recordingSocket("b5", "user-other");

    // `add` subscribes each socket to `events:user:{id}` automatically.
    await nodeA.add(a.socket);
    await nodeB.add(b.socket);

    await publishEvent(commandsB, "user", "user-alone", {
      fromUserId: "someone",
      origin: "node-b",
      ts: Date.now(),
      type: "friend.request",
    });

    await waitFor(() => a.received.length > 0);

    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(0);

    await nodeA.remove(a.socket);
    await nodeB.remove(b.socket);
  });
});
