import { describe, expect, it } from "bun:test";
import type { Client } from "cassandra-driver";
import { types } from "cassandra-driver";
import { bucketForId } from "../../src/buckets";
import { previewOf, recordMentions } from "../../src/mentions";

const AUTHOR = "aaaaaaaa-0000-4000-8000-000000000001";
const ALICE = "bbbbbbbb-0000-4000-8000-000000000002";
const BOB = "cccccccc-0000-4000-8000-000000000003";
const CHANNEL = "dddddddd-0000-4000-8000-000000000004";

function fakeClient(): {
  client: Client;
  calls: { params: unknown[]; query: string }[];
} {
  const calls: { params: unknown[]; query: string }[] = [];
  const client = {
    execute(query: string, params: unknown[]) {
      calls.push({ params, query });
      return Promise.resolve({ first: () => null, rows: [] });
    },
  } as unknown as Client;
  return { calls, client };
}

const inboxWrites = (calls: { params: unknown[]; query: string }[]) =>
  calls.filter((c) => c.query.includes("mentions_by_user"));

describe("previewOf", () => {
  it("collapses whitespace and truncates long content", () => {
    expect(previewOf("hey   there\n\nyou")).toBe("hey there you");
    const long = previewOf("a".repeat(500));
    expect(long).toHaveLength(140);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("recordMentions", () => {
  it("writes one inbox row per mentioned user, plus the message row", async () => {
    const { calls, client } = fakeClient();
    await recordMentions(client, {
      authorId: AUTHOR,
      channelId: CHANNEL,
      content: "hi @alice @bob",
      mentionedUsers: [ALICE, BOB],
      messageId: types.TimeUuid.now(),
    });

    expect(calls).toHaveLength(3);
    expect(inboxWrites(calls)).toHaveLength(2);
  });

  it("does not badge the author for mentioning themselves", async () => {
    const { calls, client } = fakeClient();
    await recordMentions(client, {
      authorId: AUTHOR,
      channelId: CHANNEL,
      content: "talking to myself",
      mentionedUsers: [AUTHOR, ALICE],
      messageId: types.TimeUuid.now(),
    });

    const recipients = inboxWrites(calls).map((c) => c.params[0]);
    expect(recipients).toEqual([ALICE]);
  });

  it("does NOT expand role mentions into inboxes", async () => {
    const { calls, client } = fakeClient();
    await recordMentions(client, {
      authorId: AUTHOR,
      channelId: CHANNEL,
      content: "@everyone ship it",
      mentionedRoles: ["eeeeeeee-0000-4000-8000-000000000005"],
      mentionsEveryone: true,
      messageId: types.TimeUuid.now(),
    });

    // One row in mentions_by_message and nothing else. Expanding a role here
    // would mean one write per member.
    expect(inboxWrites(calls)).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it("buckets by the id's timestamp, not the current clock", async () => {
    // An id minted in a previous month -- a retry or a backfill. Its inbox row
    // must land where the id sorts, or every read of that bucket misses it.
    const old = types.TimeUuid.fromDate(new Date("2026-03-14T10:00:00Z"));
    const { calls, client } = fakeClient();

    await recordMentions(client, {
      authorId: AUTHOR,
      channelId: CHANNEL,
      content: "late arrival",
      mentionedUsers: [ALICE],
      messageId: old,
    });

    expect(inboxWrites(calls)[0]?.params[1]).toBe("2026-03");
    expect(bucketForId(old)).toBe("2026-03");
  });

  it("stores a preview so the inbox never reads messages_by_channel", async () => {
    const { calls, client } = fakeClient();
    await recordMentions(client, {
      authorId: AUTHOR,
      channelId: CHANNEL,
      content: "  spaced   out  ",
      mentionedUsers: [ALICE],
      messageId: types.TimeUuid.now(),
    });

    expect(inboxWrites(calls)[0]?.params[6]).toBe("spaced out");
  });
});
