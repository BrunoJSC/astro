# astro

Turborepo monorepo on Bun — Next.js, Elysia, Expo and a shared design system,
with a typed contract running end to end from the database columns to every
client.

## Layout

| Package | What it is |
|---|---|
| `apps/web` | Next.js 16, App Router, Tailwind v4 |
| `apps/server` | Elysia API on Bun, plugin/module architecture |
| `apps/native` | Expo SDK 57, Expo Router |
| `apps/desktop` | Electron desktop client (React + Vite) |
| `packages/db` | Drizzle ORM on Neon: the relational graph |
| `packages/chat-db` | ScyllaDB: message history, audit and moderation logs |
| `packages/kv` | Redis/Valkey: presence, typing, voice state, pub/sub fan-out |
| `packages/auth` | Better Auth: Argon2id, username plugin |
| `packages/env` | T3 Env, validated per runtime |
| `packages/ui` | Base UI primitives, shadcn-style variants |
| `packages/config` | Shared TypeScript presets |

## Getting started

**On Windows 11, start with [SETUP-WINDOWS.md](SETUP-WINDOWS.md).** It covers
the prerequisites, the environment files, and — more usefully — an ordered list
of what to verify first, because most of this repository was written on a
machine that could not run it.

```bash
bun install
for d in apps/server apps/web apps/native packages/db packages/auth; do
  cp $d/.env.example $d/.env
done
bun run db:migrate
bun run dev
```

Generate a real `BETTER_AUTH_SECRET` with `openssl rand -base64 32` — the value
in `.env.example` is a 46-character placeholder that only exists to satisfy the
schema's `min(32)`.

## Commands

```bash
bun run lint            # Biome across the repo, one pass
bun run check-types     # tsc per package, through turbo
bun run test            # bun test (unit) + vitest (integration)
bun run bench           # mitata
bun run security:check  # bun audit, gated at high severity
```

## Things worth knowing

**Dependency versions live in Bun catalogs**, in the root `package.json`.
Packages reference them as `catalog:` or `catalog:<name>`, so a version is
declared once for the whole repo.

**Two connection URLs.** `DATABASE_URL` is Neon's pooled endpoint, used at
runtime. `DIRECT_URL` bypasses the pooler and is used only by drizzle-kit:
Neon's pooler runs PgBouncer in transaction mode, where DDL and advisory locks
do not behave.

**The database schema is generated.** `bun run auth:generate` in `@repo/auth`
runs the Better Auth CLI and rewrites `packages/db/src/schema/` through a
codemod that re-applies timezone-aware timestamps, UUIDv7 defaults, composite
indexes and the `account.issuer` column the CLI omits. Edit the codemod, not
the schema files. `packages/db/src/schema/generated/` holds the CLI's verbatim
output so an upgrade produces a reviewable diff, and a drift test fails when
Better Auth changes a column.

**Two datastores, split by shape.** Postgres holds the relational graph --
users, guilds, members, roles, channels, permissions -- where foreign keys and
transactions earn their cost. ScyllaDB holds everything hanging off a message: message
history, reactions, mentions, audit and moderation logs. Most are partitioned
by time bucket; reactions are not, because a message's reaction count is
bounded by its audience rather than by time. The seam is
`channel_read_state.last_read_message_id`, which stores a Scylla `timeuuid` and
is deliberately opaque to Postgres: UUIDv1 lays its timestamp out
low-bits-first, so the unread comparison has to happen in Scylla.

**The realtime gateway has never run.** `apps/server` now serves a WebSocket at
`/gateway` for presence, typing, voice and cross-node fan-out; its unit tests
pass but nothing has connected to a real Redis or browser. Proving it needs TWO
server processes — with one node the `origin` filter is untestable, since every
event is local. `apps/server/src/modules/gateway/README.md` has the steps.

**The Lua in `packages/kv` has never run against a server.** Its TypeScript is
tested; `packages/kv/README.md` says what that leaves open, and
`bun run validate:kv` settles it.

**The desktop app launches, and its credential storage is verified.** It moved from Tauri to Electron
because Tauri renders in the OS webview, and WKWebView has no `getDisplayMedia`
while WebKitGTK's WebRTC is limited — screen sharing and voice would be broken
on two of three platforms, and voice is already in the schema. Electron bundles
Chromium, and its `safeStorage` replaced the plaintext token file.
`apps/desktop/README.md` has the trade-offs and what is still unbuilt.

**The CQL has not run against a live ScyllaDB yet.** It was written on a
machine without Docker, and Scylla is Linux-only so there was no way to apply
it. `packages/chat-db/README.md` explains what that leaves unverified, and
`cd packages/chat-db && bun run validate:cql` brings up a throwaway node,
loads the schema and asserts it. Run that first on a machine with Docker.

**Every pull request gets its own database.** `.github/workflows/preview-db.yml`
creates a schema-only Neon branch, migrates it, and deletes it on close.

**One accepted CVE.** See `SECURITY-EXCEPTIONS.md`.
