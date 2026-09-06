import type { Client, types } from "cassandra-driver";
import { bucketFor, bucketForId, previousBucket } from "./buckets";

/**
 * Mentions.
 *
 * Two tables, answering two different questions:
 *
 *   mentions_by_message  what did this message mention? (rendering, and the
 *                        role-mention badge)
 *   mentions_by_user     what mentioned me? (the "@me" inbox, and the red
 *                        badge count)
 *
 * Only DIRECT mentions fan out into the inbox. A role mention stays one row in
 * mentions_by_message: expanding @role for a 50,000-member role would write
 * 50,000 inbox rows for a single message, and membership changes would make
 * them wrong with no way to rewrite history. Whether a role mention lights up
 * someone's badge is decided at read time by intersecting `mentionedRoles` with
 * the roles Postgres already holds in member_roles.
 */

/** Inbox rows carry a preview so rendering never reads messages_by_channel. */
const PREVIEW_LENGTH = 140;

export interface MentionRecord {
  authorId: string;
  channelId: string;
  contentPreview: string;
  /** Null for a DM. */
  guildId: string | null;
  messageId: types.TimeUuid;
}

export interface MentionPage {
  /** True when the walk stopped because it hit `maxBucketsScanned`. */
  boundReached: boolean;
  /**
   * Pass back as `before` for the next page.
   *
   * Null when this page collected nothing, which is not the same as an empty
   * inbox: with `boundReached` true the walk gave up first, and the caller
   * resumes by repeating `before` with a larger `maxBucketsScanned`.
   */
  cursor: types.TimeUuid | null;
  mentions: readonly MentionRecord[];
}

export interface MessageMentions {
  mentionedRoles: readonly string[];
  mentionedUsers: readonly string[];
  mentionsEveryone: boolean;
}

const INSERT_BY_MESSAGE = `
  INSERT INTO mentions_by_message (
    message_id, channel_id, mentioned_users, mentioned_roles,
    mentions_everyone, created_at
  ) VALUES (?, ?, ?, ?, ?, ?)`;

const INSERT_BY_USER = `
  INSERT INTO mentions_by_user (
    user_id, bucket_year_month, message_id, channel_id, guild_id,
    author_id, content_preview
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`;

const SELECT_BY_MESSAGE = `
  SELECT mentioned_users, mentioned_roles, mentions_everyone
    FROM mentions_by_message
   WHERE message_id = ?`;

const SELECT_INBOX_PAGE = `
  SELECT message_id, channel_id, guild_id, author_id, content_preview
    FROM mentions_by_user
   WHERE user_id = ? AND bucket_year_month = ? AND message_id < ?
   LIMIT ?`;

const SELECT_INBOX_HEAD = `
  SELECT message_id, channel_id, guild_id, author_id, content_preview
    FROM mentions_by_user
   WHERE user_id = ? AND bucket_year_month = ?
   LIMIT ?`;

/** First `PREVIEW_LENGTH` characters, ellipsised, whitespace collapsed. */
export function previewOf(content: string): string {
  const flat = content.replace(/\s+/gu, " ").trim();
  return flat.length <= PREVIEW_LENGTH
    ? flat
    : `${flat.slice(0, PREVIEW_LENGTH - 1)}…`;
}

/**
 * Records what a message mentioned, and fans the direct mentions into inboxes.
 *
 * The writes are concurrent rather than batched. A CQL batch spanning many
 * partitions is not an optimisation -- it makes one coordinator responsible for
 * every write and serialises them behind a batchlog. These rows land in as many
 * partitions as there are mentioned users, so they go out in parallel.
 *
 * There is consequently no atomicity across them: a partial failure leaves some
 * inboxes updated. That is the right trade here -- a missing badge is a far
 * cheaper defect than a coordinator hotspot, and the caller sees the rejection
 * and can retry, which is safe because every write is an idempotent upsert on
 * the same primary key.
 */
export async function recordMentions(
  client: Client,
  mention: {
    messageId: types.TimeUuid;
    channelId: string;
    guildId?: string | null;
    authorId: string;
    content: string;
    mentionedUsers?: readonly string[];
    mentionedRoles?: readonly string[];
    mentionsEveryone?: boolean;
  }
): Promise<void> {
  const users = mention.mentionedUsers ?? [];
  const roles = mention.mentionedRoles ?? [];
  // The bucket comes from the id's own timestamp, never the clock: a message
  // written late across a month boundary must land where its id sorts.
  const bucket = bucketForId(mention.messageId);
  const preview = previewOf(mention.content);

  await Promise.all([
    client.execute(
      INSERT_BY_MESSAGE,
      [
        mention.messageId,
        mention.channelId,
        users.length > 0 ? [...users] : null,
        roles.length > 0 ? [...roles] : null,
        mention.mentionsEveryone ?? false,
        mention.messageId.getDate(),
      ],
      { prepare: true }
    ),
    // The author is skipped: mentioning yourself must not badge your own inbox.
    ...users
      .filter((userId) => userId !== mention.authorId)
      .map((userId) =>
        client.execute(
          INSERT_BY_USER,
          [
            userId,
            bucket,
            mention.messageId,
            mention.channelId,
            mention.guildId ?? null,
            mention.authorId,
            preview,
          ],
          { prepare: true }
        )
      ),
  ]);
}

/** What one message mentioned. Roles come back unexpanded, by design. */
export async function getMessageMentions(
  client: Client,
  messageId: types.TimeUuid
): Promise<MessageMentions | null> {
  const result = await client.execute(SELECT_BY_MESSAGE, [messageId], {
    prepare: true,
  });
  const row = result.first();
  if (!row) {
    return null;
  }

  /*
   * Mapped to strings, not cast to them.
   *
   * The driver hands back `Uuid` instances for a `set<uuid>`, and a cast would
   * only silence the compiler. The consequence is not cosmetic: the role
   * badge is computed by intersecting `mentionedRoles` with the reader's roles
   * from Postgres, which are strings, and an array of `Uuid` objects never
   * matches one -- so the badge would silently never light up.
   */
  const ids = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(String) : [];

  return {
    mentionedRoles: ids(row.mentioned_roles),
    mentionedUsers: ids(row.mentioned_users),
    mentionsEveryone: Boolean(row.mentions_everyone),
  };
}

/**
 * The "@me" inbox, newest first.
 *
 * Same bounded backwards walk as `getChannelMessages`, and for the same reason:
 * a page can straddle a month boundary, and a user with no mentions for two
 * years would otherwise issue one query per empty bucket and never return.
 *
 * `boundReached` is the honest half of the answer: this read cannot know it
 * reached the start of the inbox, only whether it ran out of budget.
 */
export async function getUserMentions(
  client: Client,
  options: {
    userId: string;
    before?: types.TimeUuid;
    limit?: number;
    maxBucketsScanned?: number;
  }
): Promise<MentionPage> {
  const limit = options.limit ?? 50;
  const maxBuckets = options.maxBucketsScanned ?? 6;

  let bucket = options.before
    ? bucketForId(options.before)
    : bucketFor(new Date());
  let cursor = options.before;

  const collected: MentionRecord[] = [];
  let scanned = 0;

  while (collected.length < limit && scanned < maxBuckets) {
    const remaining = limit - collected.length;
    const result = cursor
      ? await client.execute(
          SELECT_INBOX_PAGE,
          [options.userId, bucket, cursor, remaining],
          { prepare: true }
        )
      : await client.execute(
          SELECT_INBOX_HEAD,
          [options.userId, bucket, remaining],
          { prepare: true }
        );

    for (const row of result.rows) {
      collected.push(toMention(row));
    }

    scanned += 1;
    bucket = previousBucket(bucket);
    // Older buckets need no cursor: every id in them is already smaller.
    cursor = undefined;
  }

  const last = collected.at(-1);
  return {
    boundReached: scanned >= maxBuckets,
    cursor: collected.length > 0 && last ? last.messageId : null,
    mentions: collected,
  };
}

function toMention(row: types.Row): MentionRecord {
  return {
    authorId: String(row.author_id),
    channelId: String(row.channel_id),
    contentPreview: (row.content_preview as string | null) ?? "",
    guildId: row.guild_id ? String(row.guild_id) : null,
    messageId: row.message_id as types.TimeUuid,
  };
}
