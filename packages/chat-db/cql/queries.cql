-- Reference queries. Every one of these is answered by the primary key alone:
-- no ALLOW FILTERING, no secondary index, no cross-partition scan.

USE astro_chat;

-- Newest N messages in a channel. First page, no cursor.
-- The clustering order is already DESC, so this reads sequentially from the
-- start of the partition.
SELECT message_id, author_id, content, attachments, embeds,
       reply_to_message_id, edited_at, is_pinned
  FROM messages_by_channel
 WHERE channel_id = ?
   AND bucket_year_month = ?
 LIMIT ?;

-- The next page. `message_id < ?` is a clustering-column range on a partition
-- already ordered DESC, so the read starts exactly at the cursor and walks
-- forward -- the cost is the page, not the offset.
--
-- Never OFFSET: CQL has none, and emulating it means fetching and discarding.
SELECT message_id, author_id, content, attachments, embeds,
       reply_to_message_id, edited_at, is_pinned
  FROM messages_by_channel
 WHERE channel_id = ?
   AND bucket_year_month = ?
   AND message_id < ?
 LIMIT ?;

-- Newer messages, for catching up after a reconnect. Note the reversal: the
-- partition is stored DESC, so ascending output needs ORDER BY, which is only
-- free because it is the exact reverse of the stored order.
SELECT message_id, author_id, content
  FROM messages_by_channel
 WHERE channel_id = ?
   AND bucket_year_month = ?
   AND message_id > ?
 ORDER BY message_id ASC
 LIMIT ?;

-- One message by id. The bucket must be derived from the id's own timestamp --
-- without it this becomes a scan of every bucket.
SELECT * FROM messages_by_channel
 WHERE channel_id = ? AND bucket_year_month = ? AND message_id = ?;

-- DMs. Identical shape, keyed by conversation.
SELECT message_id, author_id, content
  FROM direct_messages
 WHERE conversation_id = ? AND bucket_year_month = ? AND message_id < ?
 LIMIT ?;

-- Guild audit trail, newest first.
SELECT log_id, actor_id, action_type, target_id, changes_json, created_at
  FROM audit_logs_by_guild
 WHERE guild_id = ? AND bucket_year_month = ? AND log_id < ?
 LIMIT ?;

-- Moderation history. No bucket in the key, so no bucket in the query.
SELECT log_id, target_user_id, moderator_id, action, reason,
       duration_seconds, created_at
  FROM moderation_logs_by_guild
 WHERE guild_id = ? AND log_id < ?
 LIMIT ?;

-- Time-range reads use the same cursor mechanism. `maxTimeuuid`/`minTimeuuid`
-- build the boundary values from a timestamp, so a range on time becomes a
-- range on the clustering column.
SELECT message_id, content FROM messages_by_channel
 WHERE channel_id = ? AND bucket_year_month = ?
   AND message_id > maxTimeuuid(?)
   AND message_id < minTimeuuid(?);

-- Reactions on a message, already grouped by emoji because the clustering
-- order is (emoji, custom_emoji_id, user_id).
SELECT emoji_key, custom_emoji_id, user_id
  FROM reactions_by_message
 WHERE message_id = ?;

-- "Did I react with this?" -- an exact clustering key, so a single-row read
-- rather than a scan of the partition.
SELECT user_id FROM reactions_by_message
 WHERE message_id = ? AND emoji_key = ? AND user_id = ?;

-- Removing one. The full key is required: a DELETE with a partial clustering
-- key writes a range tombstone, which is far more expensive to read past.
DELETE FROM reactions_by_message
 WHERE message_id = ? AND emoji_key = ? AND user_id = ?;

-- The mention inbox, newest first, one partition read per bucket.
SELECT message_id, channel_id, guild_id, author_id, content_preview
  FROM mentions_by_user
 WHERE user_id = ? AND bucket_year_month = ? AND message_id < ?
 LIMIT ?;

-- What a message mentioned. Feeds rendering, and the role-mention badge after
-- intersecting mentioned_roles with the reader's roles from Postgres.
SELECT mentioned_users, mentioned_roles, mentions_everyone
  FROM mentions_by_message
 WHERE message_id = ?;
