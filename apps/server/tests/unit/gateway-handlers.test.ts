import { beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * The frame handlers, without a socket or a server.
 *
 * They were extracted out of the `message` switch precisely so this is
 * possible: what matters in each one is a rule -- who is allowed, what is
 * throttled, what must not be published -- and none of those need a WebSocket
 * to check.
 *
 * `@repo/kv` and `./authorize` are mocked at the module level rather than
 * injected, because the handlers import them directly and threading them
 * through the context would exist only for the tests.
 *
 * The mock SPREADS the real module rather than replacing it. `mock.module` in
 * Bun is process-global, not file-scoped: a bare replacement here also applies
 * to every other test file in the run, and `gateway-registry.test.ts` -- which
 * needs the real `subscribeEvents` -- fails with "Export not found" depending
 * on which file Bun happens to load first.
 */
import * as realKv from "@repo/kv";

const kv = {
  getTyping: mock(() => Promise.resolve([])),
  getVoiceMembers: mock(() => Promise.resolve([])),
  joinVoice: mock(() => Promise.resolve(1)),
  leaveVoice: mock(() => Promise.resolve(0)),
  // Parameters are declared so `mock.calls` is a typed tuple -- a no-arg mock
  // types every recorded call as `[]`, and reading `call[1]` is then `undefined`.
  publishEvent: mock(
    (_commands: unknown, _scope: string, _id: string, _event: unknown) =>
      Promise.resolve(1)
  ),
  startTyping: mock(() => Promise.resolve()),
  stopTyping: mock(() => Promise.resolve()),
  takeMessageSlot: mock(() =>
    Promise.resolve({ allowed: true, remaining: 4, retryAfterMs: 0 })
  ),
  touchPresence: mock(() => Promise.resolve(1)),
  updateVoiceState: mock(() => Promise.resolve(null as unknown)),
};

const authorize = {
  canAccess: mock(() => Promise.resolve(true)),
};

mock.module("@repo/kv", () => ({ ...realKv, ...kv }));
mock.module("../../src/modules/gateway/authorize", () => authorize);

const {
  handlePresenceUpdate,
  handleSubscribe,
  handleTypingStart,
  handleVoiceJoin,
  handleVoiceUpdate,
  TYPING_THROTTLE_MS,
} = await import("../../src/modules/gateway/handlers");

const USER = "01931f4c-8d2a-7000-8000-000000000001";
const CHANNEL = "01931f4c-8d2a-7000-8000-000000000002";
const GUILD = "01931f4c-8d2a-7000-8000-000000000003";

function makeContext(overrides: { now?: number } = {}) {
  const sent: unknown[] = [];
  const joined: { id: string; scope: string }[] = [];

  const context = {
    commands: {} as never,
    guildIds: [GUILD],
    nodeId: "node-a",
    now: overrides.now ?? Date.now(),
    registry: {
      join: (_socket: unknown, scope: string, id: string) => {
        joined.push({ id, scope });
        return Promise.resolve();
      },
      leave: () => Promise.resolve(),
    } as never,
    state: {
      guildIds: [GUILD],
      socket: { id: "sock-1", send: () => undefined, userId: USER },
      typingAt: new Map<string, number>(),
    },
    userId: USER,
    ws: {
      send: (payload: never) => sent.push(JSON.parse(payload as string)),
    },
  };

  return { context, joined, sent };
}

beforeEach(() => {
  for (const fn of Object.values(kv)) {
    fn.mockClear();
  }
  authorize.canAccess.mockClear();
  authorize.canAccess.mockImplementation(() => Promise.resolve(true));
  kv.takeMessageSlot.mockImplementation(() =>
    Promise.resolve({ allowed: true, remaining: 4, retryAfterMs: 0 })
  );
});

describe("handleSubscribe", () => {
  it("joins a topic the user is a member of", async () => {
    const { context, joined, sent } = makeContext();

    await handleSubscribe(context as never, {
      id: GUILD,
      op: "subscribe",
      scope: "guild",
    });

    expect(joined).toEqual([{ id: GUILD, scope: "guild" }]);
    expect(sent).toEqual([{ id: GUILD, op: "subscribed", scope: "guild" }]);
  });

  it("refuses, and does NOT join, when the user is not a member", async () => {
    // The security boundary: the client picks the id, so a missed check here
    // hands any authenticated user every event in any guild.
    authorize.canAccess.mockImplementation(() => Promise.resolve(false));
    const { context, joined, sent } = makeContext();

    await handleSubscribe(context as never, {
      id: GUILD,
      op: "subscribe",
      scope: "guild",
    });

    expect(joined).toEqual([]);
    expect(sent).toEqual([
      {
        code: "forbidden",
        message: `Not a member of guild ${GUILD}`,
        op: "error",
      },
    ]);
  });
});

describe("handleTypingStart", () => {
  it("publishes the first frame", async () => {
    const { context } = makeContext();

    await handleTypingStart(context as never, {
      channelId: CHANNEL,
      op: "typing.start",
    });

    expect(kv.startTyping).toHaveBeenCalledTimes(1);
    expect(kv.publishEvent).toHaveBeenCalledTimes(1);
  });

  it("drops a second frame inside the throttle window", async () => {
    // A client sends this on every keystroke. Without the throttle each one
    // becomes a publish that fans out to every socket in the channel.
    const { context } = makeContext({ now: 1_000_000 });

    await handleTypingStart(context as never, {
      channelId: CHANNEL,
      op: "typing.start",
    });
    context.now = 1_000_000 + TYPING_THROTTLE_MS - 1;
    await handleTypingStart(context as never, {
      channelId: CHANNEL,
      op: "typing.start",
    });

    expect(kv.publishEvent).toHaveBeenCalledTimes(1);
  });

  it("publishes again once the window has passed", async () => {
    const { context } = makeContext({ now: 1_000_000 });

    await handleTypingStart(context as never, {
      channelId: CHANNEL,
      op: "typing.start",
    });
    context.now = 1_000_000 + TYPING_THROTTLE_MS + 1;
    await handleTypingStart(context as never, {
      channelId: CHANNEL,
      op: "typing.start",
    });

    expect(kv.publishEvent).toHaveBeenCalledTimes(2);
  });

  it("throttles per channel, not per socket", async () => {
    const { context } = makeContext({ now: 1_000_000 });

    await handleTypingStart(context as never, {
      channelId: CHANNEL,
      op: "typing.start",
    });
    await handleTypingStart(context as never, {
      channelId: GUILD,
      op: "typing.start",
    });

    expect(kv.publishEvent).toHaveBeenCalledTimes(2);
  });

  it("refuses a channel the user cannot see", async () => {
    authorize.canAccess.mockImplementation(() => Promise.resolve(false));
    const { context } = makeContext();

    await handleTypingStart(context as never, {
      channelId: CHANNEL,
      op: "typing.start",
    });

    expect(kv.startTyping).not.toHaveBeenCalled();
    expect(kv.publishEvent).not.toHaveBeenCalled();
  });

  it("does not spend the message budget", async () => {
    // Typing is throttled in process precisely so it never eats the budget a
    // user needs for actually talking.
    const { context } = makeContext();

    await handleTypingStart(context as never, {
      channelId: CHANNEL,
      op: "typing.start",
    });

    expect(kv.takeMessageSlot).not.toHaveBeenCalled();
  });
});

describe("handleVoiceUpdate", () => {
  it("does not publish when the user was not in the channel", async () => {
    // `updateVoiceState` returns null for a member who is not in the roster.
    // Publishing anyway would announce a state change that did not happen.
    kv.updateVoiceState.mockImplementation(() => Promise.resolve(null));
    const { context } = makeContext();

    await handleVoiceUpdate(context as never, {
      channelId: CHANNEL,
      op: "voice.update",
      selfMute: true,
    });

    expect(kv.publishEvent).not.toHaveBeenCalled();
  });

  it("publishes when the patch applied", async () => {
    kv.updateVoiceState.mockImplementation(() =>
      Promise.resolve({ joinedAt: 1, selfMute: true } as unknown)
    );
    const { context } = makeContext();

    await handleVoiceUpdate(context as never, {
      channelId: CHANNEL,
      op: "voice.update",
      selfMute: true,
    });

    expect(kv.publishEvent).toHaveBeenCalledTimes(1);
  });
});

describe("rate limiting", () => {
  it("refuses the frame and reports when to retry", async () => {
    kv.takeMessageSlot.mockImplementation(() =>
      Promise.resolve({ allowed: false, remaining: 0, retryAfterMs: 1234 })
    );
    const { context, sent } = makeContext();

    await handleVoiceJoin(context as never, {
      channelId: CHANNEL,
      op: "voice.join",
      peerId: "peer-1",
    });

    expect(sent).toEqual([
      {
        code: "rate_limited",
        message: "Too many actions",
        op: "error",
        retryAfterMs: 1234,
      },
    ]);
    expect(kv.joinVoice).not.toHaveBeenCalled();
  });

  it("checks access before spending a slot", async () => {
    // Otherwise a client could drain its own budget probing channel ids.
    authorize.canAccess.mockImplementation(() => Promise.resolve(false));
    const { context } = makeContext();

    await handleVoiceJoin(context as never, {
      channelId: CHANNEL,
      op: "voice.join",
      peerId: "peer-1",
    });

    expect(kv.takeMessageSlot).not.toHaveBeenCalled();
  });
});

describe("presence fan-out", () => {
  it("reaches the user's own devices and every guild they are in", async () => {
    const { context } = makeContext();

    await handlePresenceUpdate(context as never, {
      op: "presence.update",
      state: "dnd",
    });

    // One publish on the user's own channel, one per guild.
    expect(kv.publishEvent).toHaveBeenCalledTimes(2);
    const scopes = kv.publishEvent.mock.calls.map((call) => call[1]);
    expect(scopes).toEqual(["user", "guild"]);
  });
});
