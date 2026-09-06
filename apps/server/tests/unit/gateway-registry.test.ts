import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { GuildEvent } from "@repo/kv";
import type { Redis } from "ioredis";
import {
  GatewayRegistry,
  type GatewaySocket,
} from "../../src/modules/gateway/registry";

/**
 * The registry is the part of the gateway that reading does not make obvious.
 *
 * Subscribing twice to one Redis channel is idempotent at the protocol level,
 * so the bug it prevents is not a duplicate subscription -- it is duplicate
 * DELIVERY, because each `subscribeEvents` call adds another `message` listener
 * on the shared connection. With one user on one node that is invisible; with
 * two members of the same guild it doubles every event.
 */

const GUILD = "01931f4c-8d2a-7000-8000-000000000001";
const OTHER_GUILD = "01931f4c-8d2a-7000-8000-000000000002";

function fakeSubscriber() {
  const emitter = new EventEmitter();
  // Unbounded: a registry holding many topics adds one listener per topic, and
  // Node's default warning at 10 would fire during the fan-out tests.
  emitter.setMaxListeners(0);

  const subscribed: string[] = [];
  const calls = { subscribe: 0, unsubscribe: 0 };

  const subscriber = Object.assign(emitter, {
    subscribe: (channel: string) => {
      calls.subscribe += 1;
      subscribed.push(channel);
      return Promise.resolve(1);
    },
    unsubscribe: (channel: string) => {
      calls.unsubscribe += 1;
      const at = subscribed.indexOf(channel);
      if (at !== -1) {
        subscribed.splice(at, 1);
      }
      return Promise.resolve(1);
    },
  }) as unknown as Redis;

  return {
    calls,
    deliver: (channel: string, payload: unknown) =>
      emitter.emit("message", channel, JSON.stringify(payload)),
    subscribed,
    subscriber,
  };
}

function fakeSocket(id: string, userId = "user-1") {
  const received: string[] = [];
  const socket: GatewaySocket = {
    id,
    send: (payload) => received.push(payload),
    userId,
  };
  return { received, socket };
}

const event: GuildEvent = {
  memberId: "someone",
  origin: "node-other",
  ts: 1_780_000_000_000,
  type: "member.joined",
};

const channelFor = (guildId: string) => `events:guild:{${guildId}}`;

describe("subscription refcounting", () => {
  it("subscribes once for two sockets on the same topic", async () => {
    const { calls, subscriber } = fakeSubscriber();
    const registry = new GatewayRegistry(subscriber, { origin: "node-a" });
    const a = fakeSocket("a");
    const b = fakeSocket("b", "user-2");

    await registry.add(a.socket);
    await registry.add(b.socket);
    const before = calls.subscribe;

    await registry.join(a.socket, "guild", GUILD);
    await registry.join(b.socket, "guild", GUILD);

    expect(calls.subscribe - before).toBe(1);
  });

  it("delivers one copy per socket, not one per subscriber", async () => {
    const { deliver, subscriber } = fakeSubscriber();
    const registry = new GatewayRegistry(subscriber, { origin: "node-a" });
    const a = fakeSocket("a");
    const b = fakeSocket("b", "user-2");

    await registry.add(a.socket);
    await registry.add(b.socket);
    await registry.join(a.socket, "guild", GUILD);
    await registry.join(b.socket, "guild", GUILD);

    deliver(channelFor(GUILD), event);

    // The regression: without refcounting each socket would receive it twice.
    expect(a.received).toHaveLength(1);
    expect(b.received).toHaveLength(1);
  });

  it("keeps the subscription while anyone is left", async () => {
    const { calls, subscribed, subscriber } = fakeSubscriber();
    const registry = new GatewayRegistry(subscriber, { origin: "node-a" });
    const a = fakeSocket("a");
    const b = fakeSocket("b", "user-2");

    await registry.add(a.socket);
    await registry.add(b.socket);
    await registry.join(a.socket, "guild", GUILD);
    await registry.join(b.socket, "guild", GUILD);

    const before = calls.unsubscribe;
    await registry.leave(a.socket, "guild", GUILD);

    expect(calls.unsubscribe).toBe(before);
    expect(subscribed).toContain(channelFor(GUILD));
  });

  it("drops it when the last one leaves", async () => {
    const { subscribed, subscriber } = fakeSubscriber();
    const registry = new GatewayRegistry(subscriber, { origin: "node-a" });
    const a = fakeSocket("a");
    const b = fakeSocket("b", "user-2");

    await registry.add(a.socket);
    await registry.add(b.socket);
    await registry.join(a.socket, "guild", GUILD);
    await registry.join(b.socket, "guild", GUILD);

    await registry.leave(a.socket, "guild", GUILD);
    await registry.leave(b.socket, "guild", GUILD);

    expect(subscribed).not.toContain(channelFor(GUILD));
  });

  it("shares one subscription between joins racing in the same tick", async () => {
    // Both see no existing subscription and would each create one, if the
    // in-flight promise were not shared.
    const { calls, subscriber } = fakeSubscriber();
    const registry = new GatewayRegistry(subscriber, { origin: "node-a" });
    const a = fakeSocket("a");
    const b = fakeSocket("b", "user-2");

    await Promise.all([registry.add(a.socket), registry.add(b.socket)]);
    const before = calls.subscribe;

    await Promise.all([
      registry.join(a.socket, "guild", GUILD),
      registry.join(b.socket, "guild", GUILD),
    ]);

    expect(calls.subscribe - before).toBe(1);
    expect(registry.topicCount).toBe(3); // two user topics, one guild
  });
});

describe("socket lifecycle", () => {
  it("subscribes a new socket to its own private channel", async () => {
    const { subscribed, subscriber } = fakeSubscriber();
    const registry = new GatewayRegistry(subscriber, { origin: "node-a" });
    const a = fakeSocket("a", "user-1");

    await registry.add(a.socket);

    expect(subscribed).toEqual(["events:user:{user-1}"]);
  });

  it("tracks a user's sockets across devices", async () => {
    const { subscriber } = fakeSubscriber();
    const registry = new GatewayRegistry(subscriber, { origin: "node-a" });
    const a = fakeSocket("a", "user-1");
    const b = fakeSocket("b", "user-1");

    await registry.add(a.socket);
    await registry.add(b.socket);

    expect(registry.socketsFor("user-1")).toHaveLength(2);
    // One subscription for the user topic, shared by both devices.
    expect(registry.topicCount).toBe(1);
  });

  it("removes a socket from every topic it had joined", async () => {
    const { subscribed, subscriber } = fakeSubscriber();
    const registry = new GatewayRegistry(subscriber, { origin: "node-a" });
    const a = fakeSocket("a");

    await registry.add(a.socket);
    await registry.join(a.socket, "guild", GUILD);
    await registry.join(a.socket, "guild", OTHER_GUILD);

    await registry.remove(a.socket);

    expect(subscribed).toEqual([]);
    expect(registry.topicCount).toBe(0);
    expect(registry.socketsFor("user-1")).toEqual([]);
  });

  it("stops delivering to a removed socket", async () => {
    const { deliver, subscriber } = fakeSubscriber();
    const registry = new GatewayRegistry(subscriber, { origin: "node-a" });
    const a = fakeSocket("a");
    const b = fakeSocket("b", "user-2");

    await registry.add(a.socket);
    await registry.add(b.socket);
    await registry.join(a.socket, "guild", GUILD);
    await registry.join(b.socket, "guild", GUILD);

    await registry.remove(a.socket);
    deliver(channelFor(GUILD), event);

    expect(a.received).toEqual([]);
    expect(b.received).toHaveLength(1);
  });
});

describe("delivery", () => {
  it("wraps the event in a routable envelope", async () => {
    const { deliver, subscriber } = fakeSubscriber();
    const registry = new GatewayRegistry(subscriber, { origin: "node-a" });
    const a = fakeSocket("a");

    await registry.add(a.socket);
    await registry.join(a.socket, "guild", GUILD);
    deliver(channelFor(GUILD), event);

    expect(JSON.parse(a.received[0] ?? "{}")).toEqual({
      event,
      op: "event",
      scope: "guild",
      topic: `guild:${GUILD}`,
    });
  });

  it("does not echo a node's own events back to it", async () => {
    const { deliver, subscriber } = fakeSubscriber();
    const registry = new GatewayRegistry(subscriber, { origin: "node-a" });
    const a = fakeSocket("a");

    await registry.add(a.socket);
    await registry.join(a.socket, "guild", GUILD);
    deliver(channelFor(GUILD), { ...event, origin: "node-a" });

    expect(a.received).toEqual([]);
  });

  it("keeps delivering after one socket's send throws", async () => {
    const errors: unknown[] = [];
    const { deliver, subscriber } = fakeSubscriber();
    const registry = new GatewayRegistry(subscriber, {
      onError: (error) => errors.push(error),
      origin: "node-a",
    });

    // A socket that died between the event arriving and this write must not
    // stop delivery to the rest.
    const broken: GatewaySocket = {
      id: "broken",
      send: () => {
        throw new Error("socket closed");
      },
      userId: "user-2",
    };
    const healthy = fakeSocket("healthy", "user-3");

    await registry.add(broken);
    await registry.add(healthy.socket);
    await registry.join(broken, "guild", GUILD);
    await registry.join(healthy.socket, "guild", GUILD);

    deliver(channelFor(GUILD), event);

    expect(healthy.received).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("routes only to the topic the event arrived on", async () => {
    const { deliver, subscriber } = fakeSubscriber();
    const registry = new GatewayRegistry(subscriber, { origin: "node-a" });
    const a = fakeSocket("a");
    const b = fakeSocket("b", "user-2");

    await registry.add(a.socket);
    await registry.add(b.socket);
    await registry.join(a.socket, "guild", GUILD);
    await registry.join(b.socket, "guild", OTHER_GUILD);

    deliver(channelFor(GUILD), event);

    expect(a.received).toHaveLength(1);
    expect(b.received).toEqual([]);
  });
});

describe("close", () => {
  it("releases every subscription", async () => {
    const { subscribed, subscriber } = fakeSubscriber();
    const registry = new GatewayRegistry(subscriber, { origin: "node-a" });
    const a = fakeSocket("a");

    await registry.add(a.socket);
    await registry.join(a.socket, "guild", GUILD);
    await registry.close();

    expect(subscribed).toEqual([]);
    expect(registry.topicCount).toBe(0);
  });
});
