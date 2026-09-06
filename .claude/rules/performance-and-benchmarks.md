---
paths:
  - "packages/db/**"
  - "packages/chat-db/**"
  - "packages/kv/**"
  - "apps/server/**"
  - "**/bench/**"
  - "**/*.cql"
---

# Performance and benchmarks

## Measure, then claim

The most expensive mistake in this repository was a confident diagnosis. An
88 ms query was blamed on planner misestimation, and partitioning was
recommended and built. The real cause was Drizzle's `.desc()` emitting
`DESC NULLS LAST`, which does not satisfy `ORDER BY id DESC`. Adding
`.nullsFirst()` took it from 91.6 ms to 0.053 ms — **1729×**. The partitioning
measured 0.060 ms: no benefit, and a schema change that would have been
permanent.

`EXPLAIN ANALYZE` before proposing an index or a partition. A number in a commit
message is worth more than a paragraph of reasoning.

## Benchmarks

`bun run bench` → `turbo run bench`. Each package's script is
`bun run bench/index.ts`, using [mitata](https://github.com/evanwashere/mitata).
**There is no `bun bench` subcommand** — typing it runs the npm script instead.

Suites exist in `@repo/db`, `@repo/auth` and `apps/server`. Any change that
alters throughput in those three needs one, and it must isolate what it claims
to measure: `packages/db/bench` calls `.toSQL()` rather than executing, so the
numbers are SQL-generation time and the suite runs in CI without a database.

Record the machine. The Argon2id parameters are justified by "67 ms on an Intel
i5-5257U @ 2.7 GHz"; a number without hardware cannot be compared to the next
one.

## ScyllaDB

**Partition keys are bucketed, and the bucket is in the key.**
`((channel_id, bucket_year_month), message_id)`. Without the bucket a busy
channel's partition grows without bound, and a partition is the unit of storage,
replication and repair — an unbounded one eventually cannot be repaired at all.

Two tables deliberately break the pattern, and both reasons are worth knowing
before adding a third:

- `reactions_by_message` is **not** bucketed. Reactions are bounded by a
  message's audience, not by time. A bucket would split one small partition into
  several and force the reaction bar — a single render — to read across them.
- `moderation_logs_by_guild` is unbounded by specification, with the ~146 MB/year
  arithmetic written into `cql/003_logs.cql`.

**Compaction follows the write pattern, not habit.** TWCS everywhere except
`reactions_by_message`, which uses LCS: it is the only table that is not
append-only — toggling a reaction is a delete followed by an insert — and TWCS
would strand tombstones in windows it never recompacts.

**Buckets come from the id's own timestamp, never `new Date()`.** Use
`bucketForId`. A message written late — a retry, a backfill, a queue that fell
behind over a month boundary — would land in the current bucket while its id
sorts into the previous one, and every read of the correct bucket would miss it
silently.

**A `timeuuid` does not sort correctly as a string.** UUIDv1 lays the timestamp
out low-bits-first, so a March id can compare greater than an April one. Scylla
sorts the *type* by timestamp; JavaScript string comparison does not. Compare
`getDate()`. `tests/unit/buckets.test.ts` pins this.

**Bound every backwards walk.** A channel dormant for two years would otherwise
issue one query per empty month and never return. `exhausted: false` means "no
more found within the bound", not "no more exists".

## Redis / Valkey

**Every ephemeral key has a TTL.** Presence 60 s renewed by heartbeat, typing
8 s strict, rate-limit windows expire with the window. A key without one is a
leak that only shows up in production, months later, as memory.

**A Set cannot expire its members.** `EXPIRE` applies to the whole key, so while
any one socket heartbeats, a socket id left by a crashed node is renewed along
with it — forever. That is why `user:socket:{u}:{s}` exists beside
`user:sockets:{u}`: each socket gets its own clock, and `reapDeadSockets`
compares the two.

**Keys carry Cluster hash tags, and they are load-bearing.**
`user:status:{u}` and `user:sockets:{u}` hash to one slot because of the braces,
which is what lets `PRESENCE_TOUCH` write both in one Lua script — a script
spanning slots is rejected with CROSSSLOT, not merely slowed. Changing a key
format means re-checking co-location; `tests/unit/keys.test.ts` computes real
CRC16/XMODEM slots rather than asserting.

**Read-then-write goes in Lua.** A sliding window built from client-side
`ZREMRANGEBYSCORE`/`ZCARD`/`ZADD` leaks under exactly the load it exists to
stop. `MULTI` does not help: it batches commands, it does not let a decision
inside the batch depend on a value read within it.

**Never make a hot read a keyspace scan.** `KEYS` blocks the server for the
length of the whole keyspace and `SCAN` walks every key in the database. That is
why typing has an index sorted set beside the per-user keys — "who is typing
here" is asked on every keystroke in every open channel.

**Pipeline what would be a round trip per item.** `getPresences` issues one
pipeline for a guild's member list; hundreds of sequential awaits is the
difference between a sidebar that renders and one that does not.

## Postgres

`$defaultFn` is not a database default — raw SQL inserts bypass it. Columns that
need one carry both: `.$defaultFn(newId).default(sql\`uuidv7()\`)`.

Composite index column order follows the hot query. `guild_members` is keyed
`(guild_id, user_id)` because "list this guild's members" is the common
question; "which guilds is this user in" gets its own index rather than a scan.

## Fan-out

**Refcount shared subscriptions.** One Redis subscription per topic, with a
local Set of sockets behind it. Subscribing twice is idempotent at the protocol
level, so the bug is duplicate *delivery* — each `subscribeEvents` call adds
another listener, and two members of one guild on one node would receive every
event twice.

**Serialise once per fan-out**, not once per socket.

**Reconnect with full jitter.** When a node dies, every client it held
reconnects at once; a fixed delay makes them arrive together, knock over
whichever node they land on, and repeat.
