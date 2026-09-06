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
| `apps/desktop` | Tauri shell (not started) |
| `packages/db` | Drizzle ORM on Neon, schema + TypeBox validation |
| `packages/auth` | Better Auth: Argon2id, username plugin |
| `packages/env` | T3 Env, validated per runtime |
| `packages/ui` | Base UI primitives, shadcn-style variants |
| `packages/config` | Shared TypeScript presets |

## Getting started

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

**Every pull request gets its own database.** `.github/workflows/preview-db.yml`
creates a schema-only Neon branch, migrates it, and deletes it on close.

**One accepted CVE.** See `SECURITY-EXCEPTIONS.md`.
