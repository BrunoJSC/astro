import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Client } from "cassandra-driver";
import { bucketForId } from "../../src/buckets";
import { getChannelMessages, insertChannelMessage } from "../../src/messages";
import {
  announceSkip,
  applySchema,
  keyspaceClient,
  newUuid,
  rawClient,
  reachable,
  timeuuidAt,
} from "./helpers";

/**
 * Message history, against a real server.
 *
 * The bucket walk is the whole reason `src/messages.ts` is not two lines. It
 * only means anything against real partitions: a fake cannot show a page
 * straddling a month boundary, and cannot show what a bucketed table refuses.
 */

const available = await reachable();
if (!available) {
  announceSkip("chat-db/messages");
}

describe.skipIf(!available)("timeuuid ordering", () => {
  let db: Client;

  beforeAll(async () => {
    const ddl = rawClient();
    await ddl.connect();
    await applySchema(ddl);
    await ddl.shutdown();

    db = keyspaceClient();
    await db.connect();
  });

  afterAll(async () => {
    await db?.shutdown();
  });

  it("sorts by the embedded timestamp, where string comparison does not", async () => {
    /*
     * The trap this package is built around. UUIDv1 lays the timestamp out
     * low-bits-first, so a March id can compare GREATER than an April one as a
     * string. The server sorts the timeuuid TYPE correctly; JavaScript does
     * not. `tests/unit/buckets.test.ts` pins the JavaScript half -- this pins
     * the server half, and the two together are the reason `bucketForId` reads
     * `getDate()` and never a string.
     */
    const channelId = newUuid();
    // The same pair `tests/unit/buckets.test.ts` uses, and the choice matters.
    const march = timeuuidAt("2026-03-15T10:00:00Z");
    const april = timeuuidAt("2026-04-01T00:00:00Z");

    /*
     * The premise, stated exactly: string ordering is UNRELIABLE, not
     * uniformly wrong. Whether it inverts depends on `time_low`, which is the
     * FIRST field in the string and the LAST in significance -- so it varies
     * with the sub-second part of the timestamp. Measured: this pair inverts,
     * while 2026-03-01 against 2026-04-01 compares correctly.
     *
     * A rule that holds for some inputs and not others is worse than one that
     * always fails, because it survives testing. That is the whole reason the
     * wrappers compare `getDate()` and never the strings.
     */
    expect(march.getDate() < april.getDate()).toBe(true);
    expect(march.toString() < april.toString()).toBe(false);

    // Same partition, so the clustering order is what decides.
    const bucket = "2026-03";
    for (const id of [march, april]) {
      await db.execute(
        `INSERT INTO messages_by_channel
           (channel_id, bucket_year_month, message_id, author_id, content)
         VALUES (?, ?, ?, ?, ?)`,
        [channelId, bucket, id, newUuid(), "x"],
        { prepare: true }
      );
    }

    const result = await db.execute(
      `SELECT message_id FROM messages_by_channel
        WHERE channel_id = ? AND bucket_year_month = ?`,
      [channelId, bucket],
      { prepare: true }
    );

    // DESC by clustering order: April, the newer one, comes first.
    expect(result.rows.map((row) => row.message_id.toString())).toEqual([
      april.toString(),
      march.toString(),
    ]);
  });
});

describe.skipIf(!available)("insertChannelMessage", () => {
  let db: Client;

  beforeAll(async () => {
    const ddl = rawClient();
    await ddl.connect();
    await applySchema(ddl);
    await ddl.shutdown();

    db = keyspaceClient();
    await db.connect();
  });

  afterAll(async () => {
    await db?.shutdown();
  });

  it("files a late write by its id's month, not the current one", async () => {
    /*
     * A retry, a backfill, a queue that fell behind over a month boundary. If
     * the bucket came from `new Date()` the row would land in the current
     * partition while its id sorts into the previous one, and every read of
     * the correct bucket would miss it silently.
     */
    const channelId = newUuid();
    const old = timeuuidAt("2026-03-15T12:00:00Z");

    await insertChannelMessage(db, {
      authorId: newUuid().toString(),
      channelId: channelId.toString(),
      content: "late arrival",
      messageId: old,
    });

    const result = await db.execute(
      `SELECT content FROM messages_by_channel
        WHERE channel_id = ? AND bucket_year_month = ?`,
      [channelId, "2026-03"],
      { prepare: true }
    );

    expect(bucketForId(old)).toBe("2026-03");
    expect(result.first()?.content).toBe("late arrival");
  });

  it("round-trips a whole message", async () => {
    const channelId = newUuid();
    const authorId = newUuid().toString();
    const replyTo = timeuuidAt("2026-09-01T10:00:00Z");

    const messageId = await insertChannelMessage(db, {
      attachments: ["a1", "a2"],
      authorId,
      channelId: channelId.toString(),
      content: "hello",
      isPinned: true,
      replyToMessageId: replyTo,
    });

    const page = await getChannelMessages(db, {
      channelId: channelId.toString(),
    });
    const [message] = page.messages;

    expect(message).toMatchObject({
      attachments: ["a1", "a2"],
      authorId,
      content: "hello",
      editedAt: null,
      isPinned: true,
    });
    expect(message?.messageId.toString()).toBe(messageId.toString());
    expect(message?.replyToMessageId?.toString()).toBe(replyTo.toString());
  });
});

describe.skipIf(!available)("the bucket walk", () => {
  let db: Client;
  const channelId = newUuid();

  beforeAll(async () => {
    const ddl = rawClient();
    await ddl.connect();
    await applySchema(ddl);
    await ddl.shutdown();

    db = keyspaceClient();
    await db.connect();

    // Three messages a month across four months: a page of 5 has to cross a
    // partition boundary to be filled.
    for (const month of ["06", "07", "08", "09"]) {
      for (const day of ["05", "15", "25"]) {
        await insertChannelMessage(db, {
          authorId: newUuid().toString(),
          channelId: channelId.toString(),
          content: `2026-${month}-${day}`,
          messageId: timeuuidAt(`2026-${month}-${day}T12:00:00Z`),
        });
      }
    }
  });

  afterAll(async () => {
    await db?.shutdown();
  });

  it("fills a page that straddles a month boundary", async () => {
    // Starting in September, which holds 3, so 5 requires reaching into August.
    const page = await getChannelMessages(db, {
      before: timeuuidAt("2026-09-30T00:00:00Z"),
      channelId: channelId.toString(),
      limit: 5,
    });

    expect(page.messages).toHaveLength(5);
    expect(page.messages.map((m) => m.content)).toEqual([
      "2026-09-25",
      "2026-09-15",
      "2026-09-05",
      "2026-08-25",
      "2026-08-15",
    ]);
  });

  it("resumes from the cursor without repeating a row", async () => {
    const first = await getChannelMessages(db, {
      before: timeuuidAt("2026-09-30T00:00:00Z"),
      channelId: channelId.toString(),
      limit: 4,
    });
    const second = await getChannelMessages(db, {
      before: first.cursor ?? undefined,
      channelId: channelId.toString(),
      limit: 4,
    });

    const seen = [...first.messages, ...second.messages].map((m) => m.content);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.slice(0, 5)).toEqual([
      "2026-09-25",
      "2026-09-15",
      "2026-09-05",
      "2026-08-25",
      "2026-08-15",
    ]);
  });

  it("starts in the cursor's own month, not the current one", async () => {
    // Resuming a page from June must not re-scan every month since.
    const page = await getChannelMessages(db, {
      before: timeuuidAt("2026-06-20T00:00:00Z"),
      channelId: channelId.toString(),
      limit: 2,
    });

    expect(page.messages.map((m) => m.content)).toEqual([
      "2026-06-15",
      "2026-06-05",
    ]);
  });

  it("reports that it stopped at the bucket bound", async () => {
    /*
     * The bound is the answer to a real failure: a channel dormant for two
     * years would otherwise issue one query per empty month and never return.
     */
    const page = await getChannelMessages(db, {
      before: timeuuidAt("2026-09-30T00:00:00Z"),
      channelId: channelId.toString(),
      limit: 100,
      maxBucketsScanned: 2,
    });

    // September and August only.
    expect(page.messages).toHaveLength(6);
    expect(page.boundReached).toBe(true);
  });

  it("still reports the bound when it searched and found nothing", async () => {
    /*
     * The case that exposed the original flag as backwards. Scanning three
     * empty months used to answer `exhausted: false`, while a FULL page --
     * which means there is almost certainly more -- answered `exhausted:
     * true`. A caller that stopped on it would truncate the conversation.
     *
     * `boundReached` is what the read can actually know: it gave up on budget,
     * so resume with the same `before` and a larger bound.
     */
    const page = await getChannelMessages(db, {
      before: timeuuidAt("2026-06-01T00:00:00Z"),
      channelId: channelId.toString(),
      limit: 10,
      maxBucketsScanned: 3,
    });

    expect(page.messages).toHaveLength(0);
    expect(page.cursor).toBeNull();
    expect(page.boundReached).toBe(true);
  });

  it("keeps channels apart", async () => {
    const page = await getChannelMessages(db, {
      channelId: newUuid().toString(),
      limit: 10,
    });

    expect(page.messages).toHaveLength(0);
  });
});
