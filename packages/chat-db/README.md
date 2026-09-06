# @repo/chat-db

ScyllaDB: message history, reactions, mentions, audit and moderation logs.

Postgres (`@repo/db`) holds the relational graph — users, guilds, members,
roles, channels, permissions — where foreign keys and transactions earn their
cost. This package holds everything that hangs off a message: high write
volume, append-mostly, read by partition, never joined.

---

## Status: the CQL has not run against a live node yet

**Read this before trusting anything below.**

The schema in `cql/` was written and reviewed but has never been applied to a
running ScyllaDB. It was authored on a borrowed machine with no Docker, no
Homebrew and no JDK, and ScyllaDB does not run natively on macOS — it is
Linux-only, so a container is the only option and there was none available.

What that means concretely:

| Checked | How |
| --- | --- |
| TypeScript wrappers, bucket arithmetic, emoji-key encoding, mention fan-out | 26 unit tests against a fake client — `bun test` |
| CQL syntax, primary keys, clustering order, compaction settings | **not yet** — needs a node |

So the first thing to do on a machine with Docker is run the harness below. It
is written to fail loudly rather than quietly, and it asserts the specific
things that are easy to get wrong and impossible to check by reading.

```bash
cd packages/chat-db && bun run validate:cql
```

That brings up a throwaway single-node Scylla, loads all four CQL files in
order, runs the assertions, prints the schema as the server actually
interpreted it, and tears everything down. First run pulls ~400MB and takes
about a minute before CQL is served; after that it is seconds.

`bun run validate:cql -- --keep` leaves the node up so you can poke at it with
`bun run scylla:cqlsh`.

If it passes, delete this section — it will have done its job.

---

## The assertion that matters most

One check in the harness is not a formality:

```
PASS  null in a clustering column is rejected
```

The reactions table exists in its current shape *because* of that rule.

A reaction is either a Unicode character or a reference to a guild emoji living
in Postgres. The obvious model is two nullable columns with exactly one set —
and it cannot work. Cassandra and Scylla reject `null` in **every** primary key
column, clustering ones included, so a Unicode reaction would be refused for its
null emoji id and a custom one for its null character. Not some inserts. All of
them.

This is the second time this project hit that class of bug from a different
direction. The Postgres `message_reactions` table that this replaces was
unusable for the mirror-image reason: a composite primary key makes its columns
implicitly `NOT NULL`, which contradicted the `CHECK` requiring exactly one of
them to be null.

The fix is one clustering column that is always populated:

```
emoji_key  →  '🎉'                              a Unicode reaction
           →  'custom:<guild_emojis uuid>'      a custom one
```

`custom_emoji_id` is kept beside it as a **regular** column — regular columns
may be null, only key columns may not — so readers get the id without parsing
the key. `emojiKey()` and `parseEmojiKey()` in `src/reactions.ts` own both
directions; nothing else should build that string. `addReaction` rejects a
Unicode emoji that starts with `custom:`, because otherwise a reference could
be forged.

If the harness ever reports that assertion as a **FAIL**, the single-column
design has stopped being load-bearing and the long comment in
`cql/004_reactions_mentions.cql` is stale.

---

## Tables

| Table | Partition | Clustering | Compaction |
| --- | --- | --- | --- |
| `messages_by_channel` | `(channel_id, bucket)` | `message_id DESC` | TWCS, 1 day |
| `direct_messages` | `(conversation_id, bucket)` | `message_id DESC` | TWCS, 1 day |
| `reactions_by_message` | `(message_id)` | `emoji_key, user_id` | **LCS** |
| `mentions_by_user` | `(user_id, bucket)` | `message_id DESC` | TWCS, 7 days |
| `mentions_by_message` | `(message_id)` | — | TWCS, 1 day |
| `audit_logs_by_guild` | `(guild_id, bucket)` | `log_id DESC` | TWCS, 7 days |
| `moderation_logs_by_guild` | `(guild_id)` | `log_id DESC` | TWCS, 30 days |

`bucket` is always `bucket_year_month`, a `'YYYY-MM'` string. Bucketing keeps a
partition from growing without bound, at the cost of the database no longer
being able to answer "the last 50" on its own — a page can straddle a boundary,
so the readers in `src/` walk backwards partition by partition.

### Two tables are deliberately not like the others

**`reactions_by_message` is not bucketed.** A message's reactions are bounded by
how many people can see it and how many distinct emoji exist; they do not grow
with time. A bucket would split one small partition into several smaller ones
and force the reaction bar — a single render — to read across all of them.

**`reactions_by_message` uses LeveledCompactionStrategy, not TWCS.** It is the
only table here that is not append-only: removing a reaction is a delete, and
toggling one is a delete followed by an insert. TWCS assumes rows are written
once and never touched, and would strand tombstones in windows it never
recompacts. LCS keeps overlap low so a partition read touches few SSTables even
after heavy churn.

---

## Mentions: roles are never expanded

`mentions_by_user` is the "@me" inbox and feeds the unread badge. Only **direct**
mentions fan out into it.

A role mention stays a single row in `mentions_by_message`. Expanding `@role`
for a 50,000-member role would mean 50,000 inbox writes for one message, and a
membership change afterwards would leave them wrong with no tractable way to
rewrite history. Whether a role mention lights up someone's badge is therefore
decided at read time, by intersecting `mentioned_roles` with the roles Postgres
already indexes in `member_roles`.

Inbox rows are denormalised on purpose — `channel_id`, `guild_id`, `author_id`
and a truncated preview are copied in at write time, so rendering twenty
mentions is one partition read instead of twenty scattered follow-ups. The
copies are immutable, so nothing has to be kept in sync.

The fan-out writes go out concurrently rather than in a CQL batch. A batch
spanning many partitions is not an optimisation — it makes one coordinator
responsible for every write and serialises them behind a batchlog. The cost is
that there is no atomicity across them: a partial failure leaves some inboxes
updated. That is the right trade, and retrying is safe because every write is an
idempotent upsert on the same primary key.

---

## Two traps worth knowing before editing anything here

**A `timeuuid` does not sort correctly as a string.** UUIDv1 lays the timestamp
out low-bits-first (`time_low-time_mid-time_hi`), so a March id can compare
greater than an April one. Scylla sorts the `timeuuid` *type* by the embedded
timestamp, which is why `ORDER BY message_id DESC` is right in CQL — but in
JavaScript, compare `getDate()` and never the strings. `tests/unit/buckets.test.ts`
pins this with an assertion that `march.toString() < april.toString()` is
`false`. Bucket strings are the opposite case: `'YYYY-MM'` sorts
lexicographically in chronological order, which is why `bucketRange` compares
them directly.

**Buckets come from the id's own timestamp, never from `new Date()`.** A message
written late — a retry, a backfill, a queue that fell behind over a month
boundary — would land in the current bucket while its id sorts into the previous
one, and every read of the correct bucket would miss it silently. Use
`bucketForId`, which is what `insertChannelMessage` and `recordMentions` both do.

---

## Counting reactions

`reaction_counts_by_message` is written out and **commented out** in
`cql/004_reactions_mentions.cql`. Reading the partition and counting rows is
correct and fine while messages carry tens of reactions; it stops being fine
when one carries 20,000 and the reaction bar reads 20,000 rows to render six
numbers.

The reason it is not enabled by default is that Cassandra counters are **not
idempotent**. A write that times out may or may not have applied, and the
driver's retry applies it again — so counts drift upward under exactly the
network conditions that cause retries, with no way to reconcile short of
recounting from the source table. Turn it on when partition reads actually
become the bottleneck, and pair it with a periodic recount rather than trusting
it indefinitely.

---

## Layout

```
cql/
  001_keyspace.cql              SimpleStrategy for dev; NetworkTopologyStrategy
                                for prod is written out and commented
  002_messages.cql              messages_by_channel, direct_messages
  003_logs.cql                  audit and moderation logs
  004_reactions_mentions.cql    reactions_by_message, mentions_by_*
  queries.cql                   every read the app performs, as reference
src/
  buckets.ts                    bucket arithmetic and the walk bounds
  client.ts                     lazy singleton, LOCAL_QUORUM, prepared statements
  messages.ts  logs.ts  reactions.ts  mentions.ts
scripts/
  validate.sh                   the harness described above
docker-compose.yml              throwaway single node, no volume
```

## Commands

```bash
bun test                  # unit tests, no database needed
bun run validate:cql      # bring up Scylla, load CQL, assert, tear down
bun run scylla:up         # just start the node
bun run scylla:cqlsh      # interactive shell against it
bun run scylla:down       # stop and remove it
```

Prepared statements are on (`prepare: true`) everywhere, and not for the query
cache — it is what lets the driver route a request straight to a replica that
owns the token instead of picking an arbitrary coordinator.
