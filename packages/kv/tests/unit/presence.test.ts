import { describe, expect, it } from "bun:test";
import {
  dropPresence,
  getPresence,
  getPresences,
  reapDeadSockets,
  startHeartbeat,
  touchPresence,
} from "../../src/presence";
import { fakeClient, only } from "./fake-client";

const USER = "01931f4c-8d2a-7000-8000-000000000001";
const SOCKET = "socket-a";

describe("touchPresence", () => {
  it("passes all three keys, so the script can expire each of them", () => {
    const { calls, client } = fakeClient({ presenceTouch: 1 });
    touchPresence(client, { socketId: SOCKET, userId: USER });

    const [call] = only(calls, "presenceTouch");
    expect(call?.args.slice(0, 3)).toEqual([
      `user:status:{${USER}}`,
      `user:sockets:{${USER}}`,
      `user:socket:{${USER}}:${SOCKET}`,
    ]);
  });

  it("sends only the fields that were supplied", async () => {
    const { calls, client } = fakeClient({ presenceTouch: 1 });
    await touchPresence(
      client,
      { socketId: SOCKET, userId: USER },
      {
        state: "dnd",
      }
    );

    const [call] = only(calls, "presenceTouch");
    // keys(3) + socketId + ttl + now, then the field pairs.
    expect(call?.args.slice(6)).toEqual(["state", "dnd"]);
  });

  it("writes an empty custom status rather than deleting the field", async () => {
    const { calls, client } = fakeClient({ presenceTouch: 1 });
    await touchPresence(
      client,
      { socketId: SOCKET, userId: USER },
      {
        customStatus: null,
      }
    );

    expect(only(calls, "presenceTouch")[0]?.args.slice(6)).toEqual([
      "custom_status",
      "",
    ]);
  });

  it("returns the live socket count, which is how first-connect is detected", async () => {
    const { client } = fakeClient({ presenceTouch: 1 });
    expect(
      await touchPresence(client, { socketId: SOCKET, userId: USER })
    ).toBe(1);
  });
});

describe("dropPresence", () => {
  it("returns remaining sockets, so one closed tab is not an offline event", async () => {
    const { client } = fakeClient({ presenceDrop: 2 });
    expect(await dropPresence(client, { socketId: SOCKET, userId: USER })).toBe(
      2
    );
  });
});

describe("reapDeadSockets", () => {
  it("reports what it removed and what survived", async () => {
    const { calls, client } = fakeClient({ presenceReap: [2, 1] });
    const result = await reapDeadSockets(client, USER);

    expect(result).toEqual({ remaining: 1, removed: 2 });
    expect(only(calls, "presenceReap")[0]?.args).toEqual([
      `user:sockets:{${USER}}`,
      `user:socket:{${USER}}:`,
    ]);
  });
});

describe("getPresence", () => {
  it("parses the hash, coercing last_active out of text", async () => {
    const { client } = fakeClient({
      hgetall: {
        client_type: "desktop",
        custom_status: "shipping",
        last_active: "1780000000000",
        state: "idle",
      },
    });

    expect(await getPresence(client, USER)).toEqual({
      clientType: "desktop",
      customStatus: "shipping",
      lastActive: 1_780_000_000_000,
      state: "idle",
    });
  });

  it("returns null for a missing key, which is not the same as offline", async () => {
    // An absent key means nothing is connected. `state: "offline"` means the
    // user chose to appear offline and is still receiving events.
    const { client } = fakeClient({ hgetall: {} });
    expect(await getPresence(client, USER)).toBeNull();
  });

  it("falls back rather than trusting an unknown state from the wire", async () => {
    const { client } = fakeClient({
      hgetall: { last_active: "1", state: "vanished" },
    });
    const presence = await getPresence(client, USER);

    expect(presence?.state).toBe("online");
    expect(presence?.clientType).toBe("web");
  });

  it("reads an empty custom status back as null", async () => {
    const { client } = fakeClient({
      hgetall: { custom_status: "", last_active: "1", state: "online" },
    });
    expect((await getPresence(client, USER))?.customStatus).toBeNull();
  });
});

describe("getPresences", () => {
  it("uses one pipeline instead of a round trip per user", async () => {
    const { calls, client } = fakeClient({
      "pipeline.exec": [
        [null, { last_active: "1", state: "online" }],
        [null, {}],
      ],
    });

    const result = await getPresences(client, [USER, "other"]);

    expect(only(calls, "pipeline.exec")).toHaveLength(1);
    // Absent, not null: the caller cannot confuse "offline" with "unknown".
    expect(result.has(USER)).toBe(true);
    expect(result.has("other")).toBe(false);
  });

  it("does not touch the network for an empty list", async () => {
    const { calls, client } = fakeClient();
    expect((await getPresences(client, [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("startHeartbeat", () => {
  it("beats on the interval and reaps alongside it", async () => {
    const { calls, client } = fakeClient({
      presenceReap: [0, 1],
      presenceTouch: 1,
    });
    const handle = startHeartbeat(client, {
      intervalMs: 10,
      socketId: SOCKET,
      userId: USER,
    });

    await new Promise((resolve) => setTimeout(resolve, 35));
    await handle.stop();

    expect(only(calls, "presenceTouch").length).toBeGreaterThanOrEqual(2);
    expect(only(calls, "presenceReap").length).toBeGreaterThanOrEqual(2);
  });

  it("drops the socket on stop rather than waiting out the TTL", async () => {
    const { calls, client } = fakeClient({ presenceTouch: 1 });
    const handle = startHeartbeat(client, {
      intervalMs: 10_000,
      socketId: SOCKET,
      userId: USER,
    });

    await handle.stop();
    expect(only(calls, "presenceDrop")).toHaveLength(1);
  });

  it("reports a failed beat instead of throwing into the timer", async () => {
    const errors: unknown[] = [];
    const client = {
      presenceDrop: () => Promise.resolve(0),
      presenceTouch: () => Promise.reject(new Error("connection lost")),
    } as never;

    const handle = startHeartbeat(client, {
      intervalMs: 10,
      onError: (error) => errors.push(error),
      socketId: SOCKET,
      userId: USER,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    await handle.stop();

    expect(errors.length).toBeGreaterThan(0);
  });
});
