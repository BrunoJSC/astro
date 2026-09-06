import { describe, expect, it } from "bun:test";
import { getTyping, startTyping, stopTyping } from "../../src/typing";
import { fakeClient, only } from "./fake-client";

const CHANNEL = "01931f4c-8d2a-7000-8000-000000000002";
const USER = "01931f4c-8d2a-7000-8000-000000000001";

describe("startTyping", () => {
  it("writes both the self-expiring key and the index", async () => {
    const { calls, client } = fakeClient({ typingStart: 1 });
    await startTyping(client, CHANNEL, USER);

    const [call] = only(calls, "typingStart");
    expect(call?.args[0]).toBe(`channel:typing:{${CHANNEL}}:${USER}`);
    expect(call?.args[1]).toBe(`channel:typing:{${CHANNEL}}`);
    expect(call?.args[4]).toBe(8000);
  });
});

describe("stopTyping", () => {
  it("clears both, so the index cannot outlive the key", async () => {
    const { calls, client } = fakeClient({ typingStop: 1 });
    await stopTyping(client, CHANNEL, USER);

    const [call] = only(calls, "typingStop");
    expect(call?.args).toEqual([
      `channel:typing:{${CHANNEL}}:${USER}`,
      `channel:typing:{${CHANNEL}}`,
      USER,
    ]);
  });
});

describe("getTyping", () => {
  it("unflattens the WITHSCORES reply into entries", async () => {
    // ZRANGE ... WITHSCORES answers [member, score, member, score].
    const { client } = fakeClient({
      typingList: [USER, "1780000008000", "other", "1780000009000"],
    });

    expect(await getTyping(client, CHANNEL)).toEqual([
      { expiresAt: 1_780_000_008_000, userId: USER },
      { expiresAt: 1_780_000_009_000, userId: "other" },
    ]);
  });

  it("reads the index, never a key pattern", async () => {
    const { calls, client } = fakeClient({ typingList: [] });
    await getTyping(client, CHANNEL);

    // KEYS and SCAN are both unacceptable on a hot path; neither may appear.
    expect(calls.map((call) => call.name)).toEqual(["typingList"]);
    expect(only(calls, "typingList")[0]?.args[0]).toBe(
      `channel:typing:{${CHANNEL}}`
    );
  });

  it("returns nothing when everyone stopped", async () => {
    const { client } = fakeClient({ typingList: [] });
    expect(await getTyping(client, CHANNEL)).toEqual([]);
  });
});
