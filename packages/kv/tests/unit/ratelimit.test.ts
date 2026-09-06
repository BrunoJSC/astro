import { describe, expect, it } from "bun:test";
import { peekMessageBudget, takeMessageSlot } from "../../src/ratelimit";
import { fakeClient, only } from "./fake-client";

const USER = "01931f4c-8d2a-7000-8000-000000000001";

describe("takeMessageSlot", () => {
  it("maps the script's tuple onto a result", async () => {
    const { client } = fakeClient({ ratelimitTake: [1, 4, 0] });

    expect(await takeMessageSlot(client, USER)).toEqual({
      allowed: true,
      remaining: 4,
      retryAfterMs: 0,
    });
  });

  it("reports when to retry rather than a fixed backoff", async () => {
    const { client } = fakeClient({ ratelimitTake: [0, 0, 1234] });
    const result = await takeMessageSlot(client, USER);

    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(1234);
  });

  it("sends a unique token per attempt", async () => {
    // Two sends in the same millisecond written under the same ZSET member
    // would collapse into one entry and count once -- letting a fast enough
    // client exceed the limit.
    const { calls, client } = fakeClient({ ratelimitTake: [1, 4, 0] });
    await takeMessageSlot(client, USER);
    await takeMessageSlot(client, USER);

    const tokens = only(calls, "ratelimitTake").map((call) => call.args[4]);
    expect(new Set(tokens).size).toBe(2);
  });

  it("passes the window and limit through", async () => {
    const { calls, client } = fakeClient({ ratelimitTake: [1, 0, 0] });
    await takeMessageSlot(client, USER, { limit: 3, windowMs: 1000 });

    const [call] = only(calls, "ratelimitTake");
    expect(call?.args[0]).toBe(`ratelimit:msg:{${USER}}`);
    expect(call?.args[2]).toBe(1000);
    expect(call?.args[3]).toBe(3);
  });
});

describe("peekMessageBudget", () => {
  it("never reports a negative budget", async () => {
    const { client } = fakeClient({ zcount: 9 });
    expect(await peekMessageBudget(client, USER, { limit: 5 })).toBe(0);
  });

  it("does not write, so a status check stays a read", async () => {
    const { calls, client } = fakeClient({ zcount: 1 });
    await peekMessageBudget(client, USER);
    expect(calls.map((call) => call.name)).toEqual(["zcount"]);
  });
});
