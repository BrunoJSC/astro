USE astro_chat;

-- ---------------------------------------------------------------------------
-- Reactions
-- ---------------------------------------------------------------------------
-- Partitioned by message and NOT bucketed, unlike everything else here. A
-- message's reactions are bounded by how many people can see it and how many
-- distinct emoji exist; it does not grow with time. A bucket would only split
-- one small partition into several smaller ones and force the reaction bar --
-- a single render -- to read across them.
--
-- ONE clustering column identifies the emoji, and it is NEVER null.
--
-- The obvious model is two nullable columns, `emoji` for Unicode and
-- `custom_emoji_id` for a guild emoji, with exactly one set. It does not work,
-- and it fails the same way the Postgres table this replaces did: Cassandra
-- rejects null in EVERY primary key column, clustering ones included
-- ("Invalid null value for clustering key part"). Every insert would be
-- refused -- a Unicode reaction for its null id, a custom one for its null
-- character. Not some. All of them.
--
-- So `emoji_key` carries both cases in one non-null value:
--
--   Unicode  ->  the character itself, e.g. '🎉'
--   Custom   ->  'custom:' + the guild_emojis uuid from Postgres
--
-- `custom_emoji_id` is kept alongside as a REGULAR column -- regular columns
-- may be null, only key columns may not -- so readers get the id without
-- parsing the key, and the source of truth stays the key.
--
-- Clustering is (emoji_key, user_id), which is the render order: rows arrive
-- already grouped by emoji, so building "🎉 x12, 🔥 x3" is a walk over a
-- sorted partition with no client-side grouping. Grouping is by emoji_key, so
-- a Unicode 🎉 and a custom emoji named :tada: stay separate -- which is what
-- Discord does too.
CREATE TABLE IF NOT EXISTS reactions_by_message (
  message_id      timeuuid,
  emoji_key       text,      -- '🎉', or 'custom:<uuid>'. Never null.
  user_id         uuid,
  custom_emoji_id uuid,      -- regular column: the uuid from emoji_key, or null
  created_at      timestamp,
  PRIMARY KEY ((message_id), emoji_key, user_id)
)
WITH CLUSTERING ORDER BY (emoji_key ASC, user_id ASC)
  AND compaction = {
    'class': 'LeveledCompactionStrategy'
  }
  -- Leveled, not TimeWindow. Reactions are the one table here that is NOT
  -- append-only: removing a reaction is a delete, and toggling one is a
  -- delete-then-insert. TWCS assumes rows are written once and never touched,
  -- and would leave tombstones scattered across windows it never recompacts.
  -- LCS keeps overlap low so a partition read touches few SSTables even after
  -- heavy churn.

  AND comment = 'Reactions on one message. Partition = one message.';


-- Counting.
--
-- The reaction bar needs "🎉 x12", and the table above answers it by reading
-- the partition and counting rows -- which is correct, and fine while messages
-- carry tens of reactions. It stops being fine in the tail: a message with
-- 20,000 reactions reads 20,000 rows to render six numbers.
--
-- The denormalised alternative is below, deliberately left commented out
-- because its failure mode is subtle and worse than the problem it solves.
-- Cassandra counters are NOT idempotent: a write that times out may or may not
-- have applied, and the driver's retry applies it again. Counts drift upward
-- under exactly the network conditions that make retries happen, and there is
-- no way to reconcile them short of recounting from the source table.
--
-- Turn it on when partition reads actually become the bottleneck, and pair it
-- with a periodic recount rather than trusting it indefinitely.
--
-- CREATE TABLE IF NOT EXISTS reaction_counts_by_message (
--   message_id      timeuuid,
--   emoji_key       text,
--   count           counter,
--   PRIMARY KEY ((message_id), emoji_key)
-- );


-- ---------------------------------------------------------------------------
-- Mentions
-- ---------------------------------------------------------------------------
-- The "@me" inbox: every mention of one user, newest first, across every
-- channel. Bucketed, because unlike reactions this DOES grow with time and has
-- no natural ceiling.
--
-- Rows are denormalised on purpose. `channel_id`, `guild_id`, `author_id` and a
-- content preview are copied in at write time so rendering the inbox is one
-- partition read -- without them, showing twenty mentions means twenty
-- follow-up reads into messages_by_channel, each in a different partition.
-- The copies are immutable, so there is nothing to keep in sync.
--
-- ONLY DIRECT MENTIONS ARE EXPANDED HERE. A role mention is one row in
-- mentions_by_message below, not one row per member: expanding @role for a
-- 50,000-member role would write 50,000 rows for a single message, and
-- rewriting them when membership changes is not tractable. The badge for a role
-- mention is computed by intersecting that table with the reader's roles, which
-- Postgres already indexes in member_roles.
CREATE TABLE IF NOT EXISTS mentions_by_user (
  user_id           uuid,
  bucket_year_month text,
  message_id        timeuuid,
  channel_id        uuid,
  guild_id          uuid,       -- null for a DM
  author_id         uuid,
  content_preview   text,       -- truncated at write time; the inbox never
                                -- renders a full message
  PRIMARY KEY ((user_id, bucket_year_month), message_id)
)
WITH CLUSTERING ORDER BY (message_id DESC)
  AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_unit': 'DAYS',
    'compaction_window_size': 7
  }
  AND comment = 'Mention inbox. Partition = one user-month. Direct mentions only.';


-- What a message mentioned. Read when rendering the message, and when deciding
-- whether a role or @everyone mention should light up someone's badge.
--
-- Sets rather than separate rows: they are read together, always, and a set is
-- a single column read instead of a partition scan. They are small by nature --
-- a message mentioning more than a handful of roles is pathological, and the
-- collection limits protect against exactly that.
CREATE TABLE IF NOT EXISTS mentions_by_message (
  message_id         timeuuid PRIMARY KEY,
  channel_id         uuid,
  mentioned_users    frozen<set<uuid>>,
  mentioned_roles    frozen<set<uuid>>,
  mentions_everyone  boolean,
  created_at         timestamp
)
WITH compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_unit': 'DAYS',
    'compaction_window_size': 1
  }
  AND comment = 'What one message mentioned. Roles stay unexpanded.';
