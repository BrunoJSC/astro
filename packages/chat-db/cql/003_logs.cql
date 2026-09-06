USE astro_chat;

-- Server audit log: who changed what, and to what.
--
-- Bucketed like messages, for the same reason -- a guild's audit trail is
-- append-only and unbounded in time. Volume is far lower than chat, so a
-- monthly window is comfortable even for a busy server.
CREATE TABLE IF NOT EXISTS audit_logs_by_guild (
  guild_id          uuid,
  bucket_year_month text,
  log_id            timeuuid,
  actor_id          uuid,
  action_type       text,
  target_id         uuid,
  changes_json      text,
  created_at        timestamp,
  PRIMARY KEY ((guild_id, bucket_year_month), log_id)
)
WITH CLUSTERING ORDER BY (log_id DESC)
  AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_unit': 'DAYS',
    'compaction_window_size': 7
  }
  -- A week per window rather than a day: audit volume is low enough that daily
  -- windows would produce many small SSTables, and each open file costs memory
  -- and a seek.

  AND comment = 'Guild audit trail. Partition = one guild-month.';


-- Moderation log: punishments issued.
--
-- ⚠ UNBOUNDED PARTITION, and deliberately so because it was specified that way.
-- `PRIMARY KEY ((guild_id), log_id)` has no bucket, so one guild's entire
-- moderation history is a single partition that only grows.
--
-- The arithmetic, so the decision is an informed one. A heavily moderated
-- server issuing 1,000 actions a day, at roughly 400 bytes a row:
--
--     1,000/day x 365 x 400 B  =  ~146 MB after one year
--                                 ~438 MB after three
--
-- Scylla's guidance is under ~100 MB, so such a server crosses the line inside
-- a year. A small server never will. If this table is ever expected to serve
-- the busy case, add `bucket_year` (a year is coarse enough given the volume)
-- to the partition key and the reader in src/moderation.ts walks it exactly the
-- way the message reader does.
--
-- Also worth knowing: the common second query is "this user's punishment
-- history", which this table cannot answer -- the partition key is the guild.
-- That needs a second table keyed by (guild_id, target_user_id). Denormalising
-- into a second write is the Cassandra answer; a secondary index on
-- target_user_id is not, because it would scan every node.
CREATE TABLE IF NOT EXISTS moderation_logs_by_guild (
  guild_id         uuid,
  log_id           timeuuid,
  target_user_id   uuid,
  moderator_id     uuid,
  action           text,
  reason           text,
  duration_seconds bigint,
  created_at       timestamp,
  PRIMARY KEY ((guild_id), log_id)
)
WITH CLUSTERING ORDER BY (log_id DESC)
  AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_unit': 'DAYS',
    'compaction_window_size': 30
  }
  AND comment = 'Moderation history. UNBOUNDED partition per guild - see notes.';
