import type { Client } from "cassandra-driver";
import { types } from "cassandra-driver";
import { bucketFor, bucketForId, previousBucket } from "./buckets";

export interface ChatMessage {
  attachments: readonly string[];
  authorId: string;
  content: string;
  editedAt: Date | null;
  embeds: string | null;
  isPinned: boolean;
  messageId: types.TimeUuid;
  replyToMessageId: types.TimeUuid | null;
}

export interface MessagePage {
  /** Pass back as `before` for the next page. Null when history is exhausted. */
  cursor: types.TimeUuid | null;
  /** False when the walk stopped at the bucket limit, not at the true start. */
  exhausted: boolean;
  messages: readonly ChatMessage[];
}

const SELECT_PAGE = `
  SELECT message_id, author_id, content, attachments, embeds,
         reply_to_message_id, edited_at, is_pinned
    FROM messages_by_channel
   WHERE channel_id = ? AND bucket_year_month = ? AND message_id < ?
   LIMIT ?`;

const SELECT_HEAD = `
  SELECT message_id, author_id, content, attachments, embeds,
         reply_to_message_id, edited_at, is_pinned
    FROM messages_by_channel
   WHERE channel_id = ? AND bucket_year_month = ?
   LIMIT ?`;

const INSERT = `
  INSERT INTO messages_by_channel (
    channel_id, bucket_year_month, message_id, author_id, content,
    attachments, embeds, reply_to_message_id, edited_at, is_pinned
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Reverse infinite scroll: the newest `limit` messages before `before`.
 *
 * This is the whole reason the wrapper exists. A page can straddle a bucket
 * boundary -- ask for 50 on the 1st of the month and the current partition may
 * hold 3 -- so the read walks backwards, partition by partition, until it has
 * enough or gives up.
 *
 * `maxBucketsScanned` bounds the walk. Without it, a channel dormant for two
 * years issues one query per empty month and the request never returns. When
 * the bound is hit, `exhausted` is false: the caller knows the answer is "no
 * more found HERE", not "no more exists", and can resume with the cursor.
 */
export async function getChannelMessages(
  client: Client,
  options: {
    channelId: string;
    before?: types.TimeUuid;
    limit?: number;
    maxBucketsScanned?: number;
  }
): Promise<MessagePage> {
  const limit = options.limit ?? 50;
  const maxBuckets = options.maxBucketsScanned ?? 6;

  // Start in the cursor's own bucket, not the current month: resuming a page
  // from last March must not re-scan every month since.
  let bucket = options.before
    ? bucketForId(options.before)
    : bucketFor(new Date());
  let cursor = options.before;

  const collected: ChatMessage[] = [];
  let scanned = 0;

  while (collected.length < limit && scanned < maxBuckets) {
    const remaining = limit - collected.length;
    const result = cursor
      ? await client.execute(
          SELECT_PAGE,
          [options.channelId, bucket, cursor, remaining],
          { prepare: true }
        )
      : await client.execute(
          SELECT_HEAD,
          [options.channelId, bucket, remaining],
          {
            prepare: true,
          }
        );

    for (const row of result.rows) {
      collected.push(toMessage(row));
    }

    scanned += 1;
    bucket = previousBucket(bucket);
    /*
     * The cursor resets to undefined when moving to an older bucket: within
     * that partition we want its newest rows, and `message_id < cursor` would
     * be redundant there -- every id in an older bucket is already smaller.
     */
    cursor = undefined;
  }

  const last = collected.at(-1);
  return {
    cursor: collected.length > 0 && last ? last.messageId : null,
    exhausted: scanned < maxBuckets,
    messages: collected,
  };
}

/**
 * Writes a message, deriving the bucket from the id rather than the clock.
 *
 * The id is generated here when absent so that the bucket and the id can never
 * disagree -- a caller passing an id minted minutes ago across a month boundary
 * would otherwise file it under the wrong partition.
 */
export async function insertChannelMessage(
  client: Client,
  message: {
    channelId: string;
    messageId?: types.TimeUuid;
    authorId: string;
    content: string;
    attachments?: readonly string[];
    embeds?: string | null;
    replyToMessageId?: types.TimeUuid | null;
    isPinned?: boolean;
  }
): Promise<types.TimeUuid> {
  const messageId = message.messageId ?? types.TimeUuid.now();

  await client.execute(
    INSERT,
    [
      message.channelId,
      bucketForId(messageId),
      messageId,
      message.authorId,
      message.content,
      message.attachments ? [...message.attachments] : [],
      message.embeds ?? null,
      message.replyToMessageId ?? null,
      null,
      message.isPinned ?? false,
    ],
    { prepare: true }
  );

  return messageId;
}

function toMessage(row: types.Row): ChatMessage {
  return {
    attachments: (row.attachments as string[] | null) ?? [],
    authorId: String(row.author_id),
    content: row.content as string,
    editedAt: (row.edited_at as Date | null) ?? null,
    embeds: (row.embeds as string | null) ?? null,
    isPinned: Boolean(row.is_pinned),
    messageId: row.message_id as types.TimeUuid,
    replyToMessageId:
      (row.reply_to_message_id as types.TimeUuid | null) ?? null,
  };
}
