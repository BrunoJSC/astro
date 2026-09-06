import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { KvClient } from "../../src/client";
import { voiceMembersKey } from "../../src/keys";
import { touchPresence } from "../../src/presence";
import {
  getVoiceMembers,
  joinVoice,
  leaveVoice,
  sweepVoiceChannel,
  updateVoiceState,
} from "../../src/voice";
import { announceSkip, connectKv, newId, reachable } from "./helpers";

const available = await reachable();
if (!available) {
  announceSkip("kv/voice");
}

const state = {
  peerId: "peer-1",
  selfDeaf: false,
  selfMute: false,
  serverDeaf: false,
  serverMute: false,
};

describe.skipIf(!available)("voice rosters", () => {
  let kv: KvClient;

  beforeAll(async () => {
    kv = await connectKv();
  });

  afterAll(async () => {
    await kv?.flushdb();
    await kv?.quit();
  });

  it("reports the roster size as people join", async () => {
    const channelId = newId();

    expect(await joinVoice(kv, channelId, newId(), state)).toBe(1);
    expect(await joinVoice(kv, channelId, newId(), state)).toBe(2);
  });

  it("round-trips the whole state through JSON", async () => {
    const channelId = newId();
    const userId = newId();
    await joinVoice(kv, channelId, userId, {
      ...state,
      peerId: "peer-abc",
      selfDeaf: true,
      serverMute: true,
    });

    const [member] = await getVoiceMembers(kv, channelId);

    expect(member).toMatchObject({
      peerId: "peer-abc",
      selfDeaf: true,
      selfMute: false,
      serverMute: true,
      userId,
    });
    expect(typeof member?.joinedAt).toBe("number");
  });

  it("merges a patch rather than replacing the member", async () => {
    const channelId = newId();
    const userId = newId();
    await joinVoice(kv, channelId, userId, { ...state, peerId: "peer-keep" });

    const updated = await updateVoiceState(kv, channelId, userId, {
      selfMute: true,
    });

    // `peerId` and `joinedAt` survive a mute toggle; without a merge a client
    // that only knows about mute would erase them.
    expect(updated).toMatchObject({ peerId: "peer-keep", selfMute: true });
    expect(updated?.joinedAt).toBeGreaterThan(0);
  });

  it("returns null when patching someone who is not in the channel", async () => {
    // Null is what tells the gateway not to publish: announcing a state change
    // that did not happen is worse than dropping the frame.
    expect(
      await updateVoiceState(kv, newId(), newId(), { selfMute: true })
    ).toBeNull();
  });

  it("deletes the hash when the last member leaves", async () => {
    const channelId = newId();
    const first = newId();
    const second = newId();
    await joinVoice(kv, channelId, first, state);
    await joinVoice(kv, channelId, second, state);

    expect(await leaveVoice(kv, channelId, first)).toBe(1);
    expect(await kv.exists(voiceMembersKey(channelId))).toBe(1);

    expect(await leaveVoice(kv, channelId, second)).toBe(0);
    /*
     * Deleted, not left as a zero-field hash. Redis keeps an empty hash around
     * as a real key, and anything listing active voice channels would count it.
     */
    expect(await kv.exists(voiceMembersKey(channelId))).toBe(0);
  });

  it("has no TTL, because a call lasts as long as it lasts", async () => {
    const channelId = newId();
    await joinVoice(kv, channelId, newId(), state);

    // -1 is "no expiry". Expiring the roster would drop everyone mid-call the
    // moment the clock ran out.
    expect(await kv.ttl(voiceMembersKey(channelId))).toBe(-1);
  });
});

describe.skipIf(!available)("sweeping ghosts", () => {
  let kv: KvClient;

  beforeAll(async () => {
    kv = await connectKv();
  });

  afterAll(async () => {
    await kv?.flushdb();
    await kv?.quit();
  });

  it("removes only the members with no presence", async () => {
    /*
     * The recovery path for a node that died holding voice sockets. Nothing
     * else notices: the roster has no TTL, so a crashed member sits in the
     * channel until something compares it against presence.
     */
    const channelId = newId();
    const live = newId();
    const ghost = newId();

    await joinVoice(kv, channelId, live, state);
    await joinVoice(kv, channelId, ghost, state);
    await touchPresence(kv, { socketId: "s1", userId: live });

    expect(await sweepVoiceChannel(kv, channelId)).toEqual([ghost]);
    expect((await getVoiceMembers(kv, channelId)).map((m) => m.userId)).toEqual(
      [live]
    );
  });

  it("does nothing to a channel where everyone is live", async () => {
    const channelId = newId();
    const userId = newId();
    await joinVoice(kv, channelId, userId, state);
    await touchPresence(kv, { socketId: "s1", userId });

    expect(await sweepVoiceChannel(kv, channelId)).toEqual([]);
  });

  it("does nothing to an empty channel", async () => {
    expect(await sweepVoiceChannel(kv, newId())).toEqual([]);
  });
});
