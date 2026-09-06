import type { Client, types } from "cassandra-driver";

/**
 * Reactions.
 *
 * The one thing worth understanding here is `emoji_key`. A reaction is either a
 * Unicode character or a reference to a guild emoji living in Postgres, and the
 * table stores that choice in a SINGLE non-null clustering column rather than
 * two nullable ones -- Cassandra rejects null in every primary key column, so
 * the two-column model cannot store either kind of reaction. See the comment
 * above the table in cql/004_reactions_mentions.cql.
 *
 * Callers never build the key by hand: they pass an `EmojiRef` and this module
 * owns the encoding on both sides.
 */

const CUSTOM_PREFIX = "custom:";

export type EmojiRef =
  | { kind: "custom"; customEmojiId: string }
  | { kind: "unicode"; emoji: string };

export interface ReactionSummary {
  /** How many users reacted with this emoji. */
  count: number;
  emoji: EmojiRef;
  /** True when the viewer passed to `getMessageReactions` is among them. */
  reactedByViewer: boolean;
  /** Reactors in clustering order, capped by the read's `maxUsersPerEmoji`. */
  userIds: readonly string[];
}

/** The stored form of an emoji reference. Never null, never ambiguous. */
export function emojiKey(emoji: EmojiRef): string {
  return emoji.kind === "custom"
    ? `${CUSTOM_PREFIX}${emoji.customEmojiId}`
    : emoji.emoji;
}

/**
 * Inverse of `emojiKey`.
 *
 * A Unicode reaction that literally began with "custom:" would be misread here,
 * which is why writes go through `addReaction` -- it rejects that string rather
 * than letting an unparseable row into the table.
 */
export function parseEmojiKey(key: string): EmojiRef {
  return key.startsWith(CUSTOM_PREFIX)
    ? { customEmojiId: key.slice(CUSTOM_PREFIX.length), kind: "custom" }
    : { emoji: key, kind: "unicode" };
}

const SELECT_REACTIONS = `
  SELECT emoji_key, custom_emoji_id, user_id
    FROM reactions_by_message
   WHERE message_id = ?`;

const INSERT_REACTION = `
  INSERT INTO reactions_by_message (
    message_id, emoji_key, user_id, custom_emoji_id, created_at
  ) VALUES (?, ?, ?, ?, ?)`;

const DELETE_REACTION = `
  DELETE FROM reactions_by_message
   WHERE message_id = ? AND emoji_key = ? AND user_id = ?`;

/**
 * Adds a reaction. Idempotent: the primary key is
 * (message, emoji, user), so reacting twice overwrites the same row rather than
 * counting twice.
 */
export async function addReaction(
  client: Client,
  reaction: {
    messageId: types.TimeUuid;
    userId: string;
    emoji: EmojiRef;
  }
): Promise<void> {
  const key = emojiKey(reaction.emoji);

  if (reaction.emoji.kind === "unicode" && key.startsWith(CUSTOM_PREFIX)) {
    throw new TypeError(
      `Unicode reaction "${key}" collides with the custom-emoji key prefix.`
    );
  }

  await client.execute(
    INSERT_REACTION,
    [
      reaction.messageId,
      key,
      reaction.userId,
      reaction.emoji.kind === "custom" ? reaction.emoji.customEmojiId : null,
      new Date(),
    ],
    { prepare: true }
  );
}

/**
 * Removes one user's reaction.
 *
 * The full primary key is always supplied. A delete with a partial clustering
 * key ("remove every reaction of this emoji") writes a range tombstone, which
 * every later read of the partition must merge past -- so that operation is
 * deliberately absent rather than offered as a convenience.
 */
export async function removeReaction(
  client: Client,
  reaction: {
    messageId: types.TimeUuid;
    userId: string;
    emoji: EmojiRef;
  }
): Promise<void> {
  await client.execute(
    DELETE_REACTION,
    [reaction.messageId, emojiKey(reaction.emoji), reaction.userId],
    { prepare: true }
  );
}

/**
 * The reaction bar for one message: one partition read, already sorted.
 *
 * Grouping is a linear pass because the clustering order is
 * (emoji_key, user_id) -- rows for the same emoji arrive adjacent, so this
 * never sorts and never builds an intermediate map keyed by anything but the
 * current run.
 *
 * `maxUsersPerEmoji` bounds what is kept in memory, not what is read. The UI
 * shows a handful of names and a count; keeping 20,000 user ids to render
 * "and 19,994 others" is waste. The count still reflects every row.
 */
export async function getMessageReactions(
  client: Client,
  options: {
    messageId: types.TimeUuid;
    viewerId?: string;
    maxUsersPerEmoji?: number;
  }
): Promise<readonly ReactionSummary[]> {
  const maxUsers = options.maxUsersPerEmoji ?? 10;
  const result = await client.execute(SELECT_REACTIONS, [options.messageId], {
    prepare: true,
  });

  const summaries: ReactionSummary[] = [];
  let currentKey: string | null = null;
  let userIds: string[] = [];

  for (const row of result.rows) {
    const key = row.emoji_key as string;
    const userId = String(row.user_id);

    if (key !== currentKey) {
      currentKey = key;
      userIds = [];
      summaries.push({
        count: 0,
        emoji: parseEmojiKey(key),
        reactedByViewer: false,
        userIds,
      });
    }

    const summary = summaries.at(-1);
    if (!summary) {
      continue;
    }
    summary.count += 1;
    if (userIds.length < maxUsers) {
      userIds.push(userId);
    }
    if (options.viewerId && userId === options.viewerId) {
      summary.reactedByViewer = true;
    }
  }

  return summaries;
}
