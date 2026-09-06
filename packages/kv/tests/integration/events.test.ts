import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Redis } from "ioredis";
import { createKvSubscriber, type KvClient } from "../../src/client";
import { publishEvent, subscribeEvents } from "../../src/events";
import type { GuildEvent } from "../../src/types";
import {
  announceSkip,
  connectKv,
  newId,
  REDIS_URL,
  reachable,
  sleep,
} from "./helpers";

/**
 * Pub/sub, against a real server.
 *
 * Two claims in this package's comments are protocol behaviour rather than
 * library behaviour, and neither has ever been executed: that a subscribed
 * connection refuses ordinary commands, and that PUBLISH answers with the
 * number of subscribers that received the message. Both are proved here.
 */

const available = await reachable();
if (!available) {
  announceSkip("kv/events");
}

const SUBSCRIBER_MODE = /subscriber mode/i;

const guildEvent = (origin: string): GuildEvent => ({
  memberId: "someone",
  origin,
  ts: Date.now(),
  type: "member.joined",
});

describe.skipIf(!available)("pub/sub", () => {
  let commands: KvClient;
  let subscriber: Redis;

  beforeAll(async () => {
    commands = await connectKv();
    subscriber = createKvSubscriber(commands);
    await subscriber.connect();
  });

  afterAll(async () => {
    await subscriber?.quit();
    await commands?.flushdb();
    await commands?.quit();
  });

  it("delivers a published event to a subscriber", async () => {
    const guildId = newId();
    const seen: GuildEvent[] = [];

    const handle = await subscribeEvents(subscriber, "guild", guildId, (e) => {
      seen.push(e);
    });

    await publishEvent(commands, "guild", guildId, guildEvent("node-a"));
    await sleep(120);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ origin: "node-a", type: "member.joined" });

    await handle.unsubscribe();
  });

  it("answers PUBLISH with the number of subscribers that got it", async () => {
    /*
     * Redis telling the truth about the cluster. A persistent zero for a busy
     * guild means the receiving nodes are not subscribed -- not that the guild
     * is quiet -- and that is worth being able to see.
     */
    const guildId = newId();

    expect(
      await publishEvent(commands, "guild", guildId, guildEvent("node-a"))
    ).toBe(0);

    const handle = await subscribeEvents(subscriber, "guild", guildId, () => {
      // Counting subscribers, not payloads.
    });

    expect(
      await publishEvent(commands, "guild", guildId, guildEvent("node-a"))
    ).toBe(1);

    await handle.unsubscribe();
  });

  it("drops an event the subscribing node published itself", async () => {
    // A node subscribes to the channels it publishes on, so without the filter
    // it delivers each of its own events twice to sockets already updated.
    const guildId = newId();
    const seen: GuildEvent[] = [];

    const handle = await subscribeEvents(
      subscriber,
      "guild",
      guildId,
      (e) => {
        seen.push(e);
      },
      { origin: "node-self" }
    );

    await publishEvent(commands, "guild", guildId, guildEvent("node-self"));
    await publishEvent(commands, "guild", guildId, guildEvent("node-other"));
    await sleep(150);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.origin).toBe("node-other");

    await handle.unsubscribe();
  });

  it("keeps scopes apart even for the same id", async () => {
    // `events:guild:{x}` and `events:user:{x}` are different channels; an id
    // reused across scopes must not cross over.
    const id = newId();
    const guildSeen: unknown[] = [];
    const userSeen: unknown[] = [];

    const guild = await subscribeEvents(subscriber, "guild", id, (e) => {
      guildSeen.push(e);
    });
    const user = await subscribeEvents(subscriber, "user", id, (e) => {
      userSeen.push(e);
    });

    await publishEvent(commands, "user", id, {
      fromUserId: "someone",
      origin: "node-a",
      ts: Date.now(),
      type: "friend.request",
    });
    await sleep(120);

    expect(userSeen).toHaveLength(1);
    expect(guildSeen).toHaveLength(0);

    await guild.unsubscribe();
    await user.unsubscribe();
  });

  it("stops delivering after unsubscribe", async () => {
    const guildId = newId();
    const seen: unknown[] = [];

    const handle = await subscribeEvents(subscriber, "guild", guildId, (e) => {
      seen.push(e);
    });
    await handle.unsubscribe();

    await publishEvent(commands, "guild", guildId, guildEvent("node-a"));
    await sleep(150);

    expect(seen).toHaveLength(0);
  });

  it("survives a payload that is not JSON", async () => {
    const guildId = newId();
    const errors: unknown[] = [];
    const seen: unknown[] = [];

    const handle = await subscribeEvents(
      subscriber,
      "guild",
      guildId,
      (e) => {
        seen.push(e);
      },
      { onError: (error) => errors.push(error) }
    );

    // Published raw, as a foreign producer on the same channel would.
    await commands.publish(`events:guild:{${guildId}}`, "{{{ not json");
    await publishEvent(commands, "guild", guildId, guildEvent("node-a"));
    await sleep(150);

    expect(errors).toHaveLength(1);
    // One bad payload must not deafen the node.
    expect(seen).toHaveLength(1);

    await handle.unsubscribe();
  });
});

describe.skipIf(!available)("connection roles", () => {
  let commands: KvClient;

  beforeAll(async () => {
    commands = await connectKv();
  });

  afterAll(async () => {
    await commands?.flushdb();
    await commands?.quit();
  });

  it("refuses ordinary commands on a subscribed RESP2 connection", async () => {
    /*
     * The protocol rule this package's comments used to state absolutely. It
     * is true, but only under RESP2: ioredis guards the connection itself and
     * rejects anything outside subscribe/unsubscribe/ping.
     */
    const subscriber = new Redis(REDIS_URL, { protocol: 2 });
    await subscriber.subscribe(`events:guild:{${newId()}}`);

    await expect(subscriber.set("some-key", "value")).rejects.toThrow(
      SUBSCRIBER_MODE
    );
    /*
     * PING stays legal -- and answers differently. In subscriber mode a RESP2
     * server replies in push format, so the result is `["pong", ""]` rather
     * than the string "PONG". Worth knowing before writing a health check that
     * compares against the string.
     *
     * The cast is not a shortcut: ioredis types `ping()` as returning the
     * literal "PONG" and does not model subscriber mode at all, so the
     * declared type is wrong for this call rather than merely imprecise.
     */
    const pong: unknown = await subscriber.ping();
    expect(pong).toEqual(["pong", ""]);

    subscriber.disconnect();
  });

  it("ALLOWS ordinary commands on a subscribed RESP3 connection", async () => {
    /*
     * And the correction. RESP3 removed the restriction, and ioredis
     * negotiates RESP3 by DEFAULT against a Redis 6+ server -- so the rule
     * does not apply to this codebase as configured.
     *
     * The two connections are still split, for reasons that outlive the
     * protocol: `enableOfflineQueue` has to be false for commands and true for
     * subscriptions, and a busy fan-out would otherwise share one socket and
     * one reply pipeline with every presence write behind it.
     */
    const subscriber = new Redis(REDIS_URL, { protocol: 3 });
    await subscriber.subscribe(`events:guild:{${newId()}}`);

    expect(await subscriber.set("resp3-key", "value")).toBe("OK");
    expect(await subscriber.get("resp3-key")).toBe("value");

    subscriber.disconnect();
  });

  it("leaves the command connection unaffected by a publish", async () => {
    // PUBLISH does not put a connection into subscriber mode, which is why the
    // publisher can keep using the command connection.
    await publishEvent(commands, "guild", newId(), guildEvent("node-a"));

    await commands.set("still-works", "yes");
    expect(await commands.get("still-works")).toBe("yes");
  });
});
