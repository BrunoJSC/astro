USE astro_chat;

-- ---------------------------------------------------------------------------
-- Bucketing: why the partition key is a pair
-- ---------------------------------------------------------------------------
-- A partition is the unit of storage, replication and repair. Everything in one
-- partition lives on the same replicas, is read from one node, and is
-- compacted, streamed and repaired as a unit. Scylla's guidance is to keep them
-- under roughly 100 MB and 100k rows.
--
-- `PRIMARY KEY (channel_id, message_id)` -- the obvious model -- has no upper
-- bound. A channel that has existed for three years IS one partition, growing
-- forever. Past a few hundred megabytes the symptoms are specific and nasty:
-- reads pull huge SSTable ranges into memory, compaction of that partition
-- needs disk equal to its own size, streaming a replacement node blocks on one
-- oversized unit, and the node holding it becomes a hotspot no amount of extra
-- capacity relieves.
--
-- Adding `bucket_year_month` to the PARTITION KEY -- note the extra parentheses
-- in `((channel_id, bucket_year_month), ...)` -- caps it by time instead. Each
-- month of a channel is its own partition, spread across the ring by the hash
-- of the pair.
--
-- Choosing the window is a traffic question, not a style one:
--
--   channel volume        rows/month     bucket
--   100 msgs/day               ~3k       month, comfortably
--   3k msgs/day                ~90k      month, near the ceiling
--   50k msgs/day              ~1.5M      DAY, or the partition is 15x too big
--
-- The format is text ('2026-09') rather than a number so buckets sort
-- lexicographically in the same order as chronologically, and so switching a
-- busy channel to '2026-09-14' is a format change rather than a schema change.
--
-- The cost is on reads: a page of 50 messages may span a month boundary, so the
-- client walks buckets backwards until it has enough. That walk is in
-- src/buckets.ts, and it is the reason this wrapper exists at all.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS messages_by_channel (
  channel_id          uuid,
  bucket_year_month   text,
  message_id          timeuuid,
  author_id           uuid,
  content             text,
  attachments         frozen<list<text>>,
  embeds              text,
  reply_to_message_id timeuuid,
  edited_at           timestamp,
  is_pinned           boolean,
  PRIMARY KEY ((channel_id, bucket_year_month), message_id)
)
WITH CLUSTERING ORDER BY (message_id DESC)
  -- Newest-first on disk. The clustering order IS the read order, so
  -- "most recent 50" is a sequential scan from the start of the partition
  -- with no sort and no reverse-iteration penalty.

  AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_unit': 'DAYS',
    'compaction_window_size': 1
  }
  -- TWCS, not the default SizeTiered. This data is append-only and
  -- time-ordered: TWCS keeps each day's writes in their own SSTables and never
  -- recompacts them afterwards. SizeTiered would repeatedly rewrite months-old
  -- messages that nobody is touching, burning IO for nothing, and would mix old
  -- and new rows into the same files so no read could skip a file by time.

  AND default_time_to_live = 0
  -- No expiry. Set this (in seconds) only if message history is meant to be
  -- discarded; with TWCS, expired data drops whole SSTables rather than
  -- generating tombstones.

  AND comment = 'Channel history. Partition = one channel-month.';

-- Direct messages. Same shape, keyed by conversation.
--
-- `conversation_id` is derived from the participant pair, not random -- both
-- sides must compute the same value or they read different partitions. Derive
-- it by sorting the two user ids and hashing the pair, the same canonical
-- ordering the Postgres `friends` table uses.
CREATE TABLE IF NOT EXISTS direct_messages (
  conversation_id     uuid,
  bucket_year_month   text,
  message_id          timeuuid,
  author_id           uuid,
  content             text,
  attachments         frozen<list<text>>,
  embeds              text,
  reply_to_message_id timeuuid,
  edited_at           timestamp,
  is_pinned           boolean,
  PRIMARY KEY ((conversation_id, bucket_year_month), message_id)
)
WITH CLUSTERING ORDER BY (message_id DESC)
  AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_unit': 'DAYS',
    'compaction_window_size': 1
  }
  AND comment = 'DM history. Partition = one conversation-month.';
