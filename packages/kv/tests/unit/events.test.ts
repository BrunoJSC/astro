import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { Redis } from "ioredis";
import { publishEvent, subscribeEvents } from "../../src/events";
import type { GuildEvent } from "../../src/types";
import { fakeClient, only, waitFor } from "./fake-client";

const GUILD = "01931f4c-8d2a-7000-8000-000000000003";

/** A subscriber that lets a test deliver a message as Redis would. */
function fakeSubscriber(): {
  deliver: (channel: string, payload: string) => void;
  subscribed: string[];
  subscriber: Redis;
} {
  const emitter = new EventEmitter();
  const subscribed: string[] = [];

  const subscriber = Object.assign(emitter, {
    subscribe: (channel: string) => {
      subscribed.push(channel);
      return Promise.resolve(1);
    },
    unsubscribe: (channel: string) => {
      subscribed.splice(subscribed.indexOf(channel), 1);
      return Promise.resolve(1);
    },
  }) as unknown as Redis;

  return {
    deliver: (channel, payload) => emitter.emit("message", channel, payload),
    subscribed,
    subscriber,
  };
}

const event: GuildEvent = {
  memberId: "someone",
  origin: "node-a",
  ts: 1_780_000_000_000,
  type: "member.joined",
};

describe("publishEvent", () => {
  it("publishes JSON on the scope's channel", async () => {
    const { calls, client } = fakeClient({ publish: 2 });
    const received = await publishEvent(client, "guild", GUILD, event);

    const [call] = only(calls, "publish");
    expect(call?.args[0]).toBe(`events:guild:{${GUILD}}`);
    expect(JSON.parse(call?.args[1] as string)).toEqual(event);
    // Redis answers with the subscriber count, which is the cluster telling
    // the truth about whether anyone is listening.
    expect(received).toBe(2);
  });
});

describe("subscribeEvents", () => {
  it("delivers a parsed payload", async () => {
    const { deliver, subscriber } = fakeSubscriber();
    const seen: GuildEvent[] = [];

    await subscribeEvents(subscriber, "guild", GUILD, (e) => {
      seen.push(e);
    });
    deliver(`events:guild:{${GUILD}}`, JSON.stringify(event));

    expect(seen).toEqual([event]);
  });

  it("drops events this node published itself", async () => {
    // A node subscribes to the channels it publishes on. Without the origin
    // filter it re-delivers its own events to sockets already updated locally.
    const { deliver, subscriber } = fakeSubscriber();
    const seen: GuildEvent[] = [];

    await subscribeEvents(
      subscriber,
      "guild",
      GUILD,
      (e) => {
        seen.push(e);
      },
      {
        origin: "node-a",
      }
    );
    deliver(`events:guild:{${GUILD}}`, JSON.stringify(event));

    expect(seen).toEqual([]);
  });

  it("still delivers events from other nodes", async () => {
    const { deliver, subscriber } = fakeSubscriber();
    const seen: GuildEvent[] = [];

    await subscribeEvents(
      subscriber,
      "guild",
      GUILD,
      (e) => {
        seen.push(e);
      },
      {
        origin: "node-b",
      }
    );
    deliver(`events:guild:{${GUILD}}`, JSON.stringify(event));

    expect(seen).toHaveLength(1);
  });

  it("ignores traffic for other channels on the shared connection", async () => {
    const { deliver, subscriber } = fakeSubscriber();
    const seen: GuildEvent[] = [];

    await subscribeEvents(subscriber, "guild", GUILD, (e) => {
      seen.push(e);
    });
    deliver("events:guild:{someone-else}", JSON.stringify(event));

    expect(seen).toEqual([]);
  });

  it("reports malformed JSON instead of killing the listener", async () => {
    const { deliver, subscriber } = fakeSubscriber();
    const errors: unknown[] = [];
    const seen: GuildEvent[] = [];

    await subscribeEvents(
      subscriber,
      "guild",
      GUILD,
      (e) => {
        seen.push(e);
      },
      {
        onError: (error) => errors.push(error),
      }
    );

    deliver(`events:guild:{${GUILD}}`, "{ not json");
    deliver(`events:guild:{${GUILD}}`, JSON.stringify(event));

    expect(errors).toHaveLength(1);
    // The subscription survived: one bad payload must not deafen the node.
    expect(seen).toHaveLength(1);
  });

  it("isolates a throwing handler", async () => {
    const { deliver, subscriber } = fakeSubscriber();
    const errors: unknown[] = [];

    await subscribeEvents(
      subscriber,
      "guild",
      GUILD,
      () => {
        throw new Error("handler blew up");
      },
      { onError: (error) => errors.push(error) }
    );

    expect(() =>
      deliver(`events:guild:{${GUILD}}`, JSON.stringify(event))
    ).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it("catches a rejected async handler", async () => {
    const { deliver, subscriber } = fakeSubscriber();
    const errors: unknown[] = [];

    await subscribeEvents(
      subscriber,
      "guild",
      GUILD,
      () => Promise.reject(new Error("async blew up")),
      { onError: (error) => errors.push(error) }
    );

    deliver(`events:guild:{${GUILD}}`, JSON.stringify(event));
    // The handler rejects asynchronously, so the error arrives a turn or more
    // later. Waited for rather than slept through, for the same reason as the
    // heartbeat tests: 5ms is a bet, and the condition is not.
    await waitFor(() => errors.length > 0, {
      what: "the reported handler error",
    });

    expect(errors).toHaveLength(1);
  });

  it("stops delivering after unsubscribe", async () => {
    const { deliver, subscribed, subscriber } = fakeSubscriber();
    const seen: GuildEvent[] = [];

    const handle = await subscribeEvents(subscriber, "guild", GUILD, (e) => {
      seen.push(e);
    });
    expect(subscribed).toEqual([`events:guild:{${GUILD}}`]);

    await handle.unsubscribe();
    deliver(`events:guild:{${GUILD}}`, JSON.stringify(event));

    expect(seen).toEqual([]);
    expect(subscribed).toEqual([]);
  });
});
