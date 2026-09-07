# Roadmap

An analysis of what this repository is, as of commit `06349c4`, and what it
needs next — in dependency order, with the measurement behind each claim.

---

## The diagnosis

**The infrastructure is built and tested. The product is not wired into it.**

| Evidence | Measured |
|---|---|
| `@repo/chat-db` — four CQL files, 85 tests | **imported by nothing** outside itself |
| Fourteen Postgres tables | **twelve have no consumer**; `channels` and `guild_members` are only *read*, by the gateway's permission check |
| The HTTP surface | `/health`, `/v1/me`, and the `/gateway` socket — nothing else |
| The pub/sub event contract | `message.created`, `message.updated`, `reaction.added` and the rest **exist** in `packages/kv/src/types.ts` — and nothing publishes them |

The write path does not exist. You cannot create a guild, create a channel,
send a message, or react to one. Every piece is built and tested; none of them
is connected to another.

That is a better position than it sounds. The parts that are hard to get right
later — partition keys, hash-tag co-location, the auth boundary, the fan-out
refcount — are done and have tests. What is missing is the wiring, and wiring
is the part that is cheap to change.

---

## 1. Make CI run the 141 tests it currently skips

**Cost: small. Leverage: the highest here.**

`.github/workflows/ci.yml` runs `bun run test`, but has no service containers.
`DATABASE_URL` points at `localhost:5432` and nothing starts a Postgres, so
every suite that needs a datastore skips — silently and by design, because the
suites are written to skip with an instruction rather than fail.

That is 141 of 568 tests, and they are the ones that cost the most to write:
the Redis Lua, the CQL schema, the Postgres 18 migration, the Better Auth
sign-up path. They were green on a machine that no longer exists.

Add service containers to the `tests` job:

- **Postgres 18** — the schema defaults to `uuidv7()`, which 17 does not have.
- **Valkey** (or Redis 7+) on 6379.
- **Cassandra 5** or Scylla for `@repo/chat-db`; the suite already runs against
  Cassandra, which is the engine Scylla maintains CQL compatibility with.

Until this exists, nothing enforces the test investment anywhere.

## 2. Publish the commits

Ten commits sit ahead of `origin/main` on a borrowed machine.

## 3. Guild and channel CRUD

`POST /v1/guilds`, `POST /v1/guilds/:id/channels`, and the membership rows that
go with them. Nothing can be created today, so nothing else has anywhere to
happen.

The schema, the enums and the constraints are already there and exercised by
`packages/db/tests/e2e/` — including the cascade behaviour and the
self-referencing category key that lifts children instead of deleting them.

## 4. The message path, end to end

**The keystone.** `POST /v1/channels/:id/messages` → `@repo/chat-db` insert →
publish `message.created` → the gateway fans out → clients render.

This is the first time `@repo/chat-db` becomes reachable, and it uses every
piece already built: the bucketed partition key, the timeuuid ordering, the
refcounted subscriptions, the rate limiter that `handlers.ts` already gates
frames with. When it works in two browser tabs, the product exists.

Worth doing as one thin vertical slice before broadening: one guild, one
channel, one message appearing in a second tab.

## 5. Direct messages

`apps/server/src/modules/gateway/authorize.ts` **denies DM channels**, on
purpose: `channels.guild_id` is null for them and there is no participant
table, so a generic guild check has nothing to check. Failing closed was the
right call — allowing by omission would let any signed-in user subscribe to any
DM by id — but it means DMs are currently unreachable.

Needs `channel_recipients (channel_id, user_id)` and one more branch in
`canAccessChannel`.

## 6. Prove the gateway with two nodes

`apps/server/tests/e2e/gateway-fanout.test.ts` — four tests — needs a real
Redis and **two** server processes. With one node every event is local, so the
`origin` filter that stops a node echoing its own events cannot be observed at
all. It is the only part of the gateway that has never run.

Item 1 makes this runnable in CI.

## 7. Read state and unread counts

`channel_read_state` exists, with the Scylla `timeuuid` and the reason the
comparison has to happen in Scylla rather than Postgres. No consumer.

## 8. Voice

The schema, the Redis rosters and the gateway's signalling frames exist. **There
is no media layer.** This is the largest single missing piece, and it is the
reason the desktop app moved from Tauri to Electron — WKWebView has no
`getDisplayMedia`.

## 9. The web app

Four routes and a username form. The desktop and native clients are further
along in plumbing than the web one is.

---

## Not on this list, and why

**A full Data Access Layer for `apps/web`.** The Next docs recommend it and it
is the right shape eventually. The app has four routes and no data access
today; the discussion is worth having when there is something to centralise.

**Rewriting anything that already has tests.** The parts that look unused —
`@repo/chat-db`, most of the schema, the rate limiter's client API — are not
unfinished. They are finished and unwired, which is items 3 and 4.

See [README.md](README.md) for what each package holds and
[SETUP-WINDOWS.md](SETUP-WINDOWS.md) for the ordered verification backlog on a
machine that can actually run this.
