import { describe, expect, it } from "bun:test";
import {
  channelEventChannel,
  idFromKey,
  rateLimitKey,
  typingIndexKey,
  typingKey,
  userSocketKey,
  userSocketPrefix,
  userSocketsKey,
  userStatusKey,
  voiceMembersKey,
} from "../../src/keys";

const HASH_TAG_ERROR = /hash tag/;
const USER = "01931f4c-8d2a-7000-8000-000000000001";
const CHANNEL = "01931f4c-8d2a-7000-8000-000000000002";

/**
 * Redis Cluster's own slot function: CRC16/XMODEM of the hash tag, mod 16384.
 *
 * Reimplemented here rather than asserted about, because the whole key scheme
 * rests on the claim that certain keys land on the same node. A comment saying
 * so is worth nothing; this computes it.
 */
function slotOf(key: string): number {
  const open = key.indexOf("{");
  const close = key.indexOf("}", open + 1);
  const hashed =
    open !== -1 && close > open + 1 ? key.slice(open + 1, close) : key;

  let crc = 0;
  for (const byte of new TextEncoder().encode(hashed)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 0x80_00) === 0 ? crc << 1 : (crc << 1) ^ 0x10_21;
      crc &= 0xff_ff;
    }
  }
  return crc % 16_384;
}

describe("cluster slot co-location", () => {
  it("puts a user's presence keys on one node", () => {
    // PRESENCE_TOUCH writes all three in one Lua script. Different slots and
    // Redis rejects it with CROSSSLOT -- the script never runs at all.
    const slots = new Set([
      slotOf(userStatusKey(USER)),
      slotOf(userSocketsKey(USER)),
      slotOf(userSocketKey(USER, "socket-a")),
    ]);

    expect(slots.size).toBe(1);
  });

  it("puts a channel's typing keys on one node", () => {
    // Redis reads only the FIRST brace group, so the per-user key is tagged by
    // the channel even though the user id follows it.
    expect(slotOf(typingKey(CHANNEL, USER))).toBe(
      slotOf(typingIndexKey(CHANNEL))
    );
  });

  it("is what the braces buy -- without them the keys scatter", () => {
    // The control. If this ever passes, the hash tags stopped working and
    // every multi-key script in this package is one deploy from breaking.
    const bare = new Set([
      slotOf(`user:status:${USER}`),
      slotOf(`user:sockets:${USER}`),
    ]);

    expect(bare.size).toBe(2);
  });

  it("keeps unrelated users apart, so the keyspace still spreads", () => {
    const other = "01931f4c-8d2a-7000-8000-00000000000f";
    expect(slotOf(userStatusKey(USER))).not.toBe(slotOf(userStatusKey(other)));
  });
});

describe("key formats", () => {
  it("matches the specified shapes", () => {
    expect(userStatusKey(USER)).toBe(`user:status:{${USER}}`);
    expect(userSocketsKey(USER)).toBe(`user:sockets:{${USER}}`);
    expect(typingKey(CHANNEL, USER)).toBe(
      `channel:typing:{${CHANNEL}}:${USER}`
    );
    expect(voiceMembersKey(CHANNEL)).toBe(`voice:channel:{${CHANNEL}}:members`);
    expect(rateLimitKey(USER)).toBe(`ratelimit:msg:{${USER}}`);
    expect(channelEventChannel(CHANNEL)).toBe(`events:channel:{${CHANNEL}}`);
  });

  it("builds the prefix the reaper rebuilds liveness keys from", () => {
    const key = userSocketKey(USER, "socket-a");
    expect(key.startsWith(userSocketPrefix(USER))).toBe(true);
    expect(key).toBe(`user:socket:{${USER}}:socket-a`);
  });
});

describe("id handling", () => {
  it("recovers the id from a key or a pub/sub channel", () => {
    expect(idFromKey(userStatusKey(USER))).toBe(USER);
    expect(idFromKey(channelEventChannel(CHANNEL))).toBe(CHANNEL);
    expect(idFromKey("no-tag-here")).toBeNull();
  });

  it("rejects ids that would break the hash tag", () => {
    // A brace inside the id would close the tag early and silently move the
    // key to a different slot than its siblings.
    expect(() => userStatusKey("has{brace")).toThrow(HASH_TAG_ERROR);
    expect(() => userStatusKey("has space")).toThrow(HASH_TAG_ERROR);
    expect(() => userStatusKey("")).toThrow(HASH_TAG_ERROR);
  });
});
