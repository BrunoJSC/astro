# astro

A Discord-shaped realtime platform, built as a Turborepo monorepo on Bun. One
typed contract runs end to end: from the database columns, through the API's
route definitions, out to the web, native and desktop clients.

Four applications, seven shared packages, three datastores chosen by the shape
of what they hold. **568 tests**, of which 427 need nothing but a checkout.

---

## Contents

- [Stack](#stack)
- [Layout](#layout)
- [The applications](#the-applications)
- [The packages](#the-packages)
- [Data model](#data-model)
- [Testing](#testing)
- [What the tests found](#what-the-tests-found)
- [What has never run](#what-has-never-run)
- [Getting started](#getting-started)
- [Commands](#commands)
- [Conventions](#conventions)

---

## Stack

Every version below is declared once, in the root `package.json` under Bun's
catalogs. Packages reference them as `catalog:` or `catalog:<name>`, so a
version exists in exactly one place.

| Area | Choice | Version |
|---|---|---|
| Runtime, package manager, test runner | **Bun** | 1.4 |
| Monorepo orchestration | **Turborepo** | 2.10 |
| Language | **TypeScript** | 7.0 |
| Lint and format | **Biome** via **Ultracite** | 2.5 / 7.10 |
| Git hooks | **Lefthook** | 2.1 |
| Web | **Next.js** (App Router) + **React** | 16.3 / 19.1 |
| API | **ElysiaJS** on Bun, **Eden Treaty** client | 1.4 |
| Native | **Expo** SDK 57, **Expo Router**, React Native | 57 / 0.86 |
| Desktop | **Electron** + **electron-vite** + **Vite** | 44 / 5 / 6 |
| Relational store | **Neon Postgres 18** via **Drizzle ORM** | 0.45 |
| Message store | **ScyllaDB** via `cassandra-driver` | 4.9 |
| Ephemeral state | **Redis / Valkey** via **ioredis** | 6 |
| Auth | **Better Auth** + **Argon2id** | 1.2 / 0.45 |
| Validation | **Zod** + **T3 Env** + **TypeBox** | 4.5 / 0.13 / 0.34 |
| UI | **Base UI** + **Tailwind CSS v4** + **CVA** | 1.0-rc / 4.3 |
| Editor | **TipTap** + **frimousse** | 3.31 / 0.3 |
| Client state | **TanStack Query** + **Zustand** + **TanStack Form** | 5.10 / 5.0 / 1.33 |
| Integration tests | **Vitest** | 5.0 |
| Benchmarks | **mitata** | 1.0 |

---

## Layout

```
apps/
  server/     ElysiaJS API + the /gateway WebSocket
  web/        Next.js 16, App Router
  native/     Expo SDK 57
  desktop/    Electron
packages/
  db/         Drizzle on Neon Postgres — the relational graph
  chat-db/    ScyllaDB — message history, reactions, mentions, audit logs
  kv/         Redis/Valkey — presence, typing, voice, pub/sub fan-out
  auth/       Better Auth — Argon2id, username plugin
  env/        T3 Env — one validated entry point per runtime
  ui/         Base UI primitives with shadcn-style variants
  config/     TypeScript presets
```

One name differs from the obvious: the ScyllaDB package is **`packages/chat-db`**,
not `packages/scylla`.

---

## The applications

### `apps/server` — the API and the gateway

ElysiaJS on Bun, organised as plugins (cross-cutting) and modules (routes).

```
src/
  index.ts          composition root, graceful shutdown on SIGTERM/SIGINT
  eden.ts, type.ts  the typed client surface every other app imports
  plugins/          auth.ts  kv.ts  query.ts  swagger.ts
  modules/
    auth/           Better Auth handler mount
    health/         liveness
    v1/             the versioned REST surface
    gateway/        the WebSocket
```

The gateway is the largest single piece of design here. `/gateway` carries
presence, typing indicators, voice state and cross-node fan-out:

- **`registry.ts`** refcounts subscriptions. One Redis subscription per topic
  with a local Set of sockets behind it — subscribing twice is idempotent at
  the protocol level, so the bug being avoided is duplicate *delivery*, not
  duplicate subscription.
- **`authorize.ts`** checks `guild_members` before honouring a `subscribe`
  frame. Authenticated is not authorised: the id comes from the client. DM
  channels have `guild_id = null` and no participant table, so they are
  **denied** — failing closed, because allowing by omission would let any
  signed-in user subscribe to any DM by id.
- **`authenticate.ts`** reads the session token from the WebSocket
  subprotocol, base64url-encoded. A raw Better Auth token ends in `=`, which is
  outside RFC 7230's `token` charset, and the browser refuses to open the
  socket at all.
- **`startSessionWatch`** re-runs `getSession` on the heartbeat interval,
  because Elysia's Bun adapter snapshots the context once at upgrade and never
  refreshes it. A *failed* lookup must not close the socket — only an explicit
  "no session" — or one database hiccup disconnects every client at once.
- **`model.ts`** validates inbound frames strictly with TypeBox and declares
  outbound ones permissively. Keep that asymmetry.

### `apps/web` — Next.js 16

App Router, React Server Components by default, Tailwind v4 through the shared
design system. Environment validation runs twice: in `next.config.ts` at build
time and in `instrumentation.ts` at server boot, because the build environment
is usually CI with placeholders and the boot environment is the one that
matters.

`cacheComponents` is on and all three routes prerender static.

### `apps/native` — Expo SDK 57

Expo Router, new architecture enabled, React Compiler on. The session lives in
`expo-secure-store` — the Keychain on iOS, EncryptedSharedPreferences on
Android — rather than AsyncStorage, which is a plaintext file.

`env-preload.ts` exists for an ordering reason worth knowing: `expo export`
evaluates `app.config.ts` **before** applying `.env`, and ESM hoists imports
above statements, so the loader has to be its own side-effect module imported
first.

### `apps/desktop` — Electron

Migrated from Tauri. The reason is not preference: Tauri renders in the OS
webview, WKWebView has no `getDisplayMedia`, and WebKitGTK's WebRTC is limited
— screen sharing and voice would be broken on two of three platforms, and voice
is already in the schema. Electron bundles Chromium, and its `safeStorage`
replaced a plaintext token file.

The renderer is untrusted. `sandbox`, `contextIsolation` and
`nodeIntegration: false` are spelled out even where they are already the
default, so a changed default cannot silently open the app up. The preload
bridge exposes **named verbs only** — never `ipcRenderer`, and never a channel
name chosen by the renderer, because a renderer that can name its own channel
can invoke every handler the main process registered.

---

## The packages

### `packages/db` — Postgres, through Drizzle

Fourteen tables, three enums, and the relational graph: users, guilds, members,
roles, channels, permission overrides, invites, friends, emojis, read state.

- **Primary keys carry two defaults.** `$defaultFn(newId)` is a Drizzle-side
  default that runs in JavaScript, so a raw SQL insert — a migration, a
  backfill, psql — bypasses it entirely and hits NOT NULL. Every key also
  carries `.default(sql\`uuidv7()\`)`, a Postgres 18 builtin.
- **UUIDv7, not v4.** A v4 key scatters inserts across the index; v7 appends,
  and range scans by id become range scans by time.
- **The schema is generated.** `bun run auth:generate` runs the Better Auth CLI
  and then a codemod re-applies timezone-aware timestamps, UUIDv7 defaults,
  composite indexes and the `account.issuer` column the CLI omits. **Edit the
  codemod, never the generated files.** `src/schema/generated/` holds the CLI's
  verbatim output so an upgrade produces a reviewable diff, and a drift test
  fails when Better Auth changes a column.
- **Two connection URLs.** `DATABASE_URL` is Neon's pooled endpoint for
  runtime; `DIRECT_URL` bypasses the pooler and is used only by drizzle-kit,
  because Neon's pooler runs PgBouncer in transaction mode where DDL and
  advisory locks do not behave.

### `packages/chat-db` — ScyllaDB

Everything hanging off a message: history, reactions, mentions, audit and
moderation logs. Four CQL files under `cql/`, applied by a harness rather than
a migration tool.

- **Partition keys are bucketed, and the bucket is in the key** —
  `((channel_id, bucket_year_month), message_id)`. A partition is the unit of
  storage, replication and repair; an unbounded one eventually cannot be
  repaired at all.
- **Two tables deliberately break that pattern.** `reactions_by_message` is not
  bucketed, because reactions are bounded by a message's audience rather than
  by time, and a bucket would split one small partition and force the reaction
  bar — a single render — to read across several. `moderation_logs_by_guild` is
  unbounded by specification, with the ~146 MB/year arithmetic written into
  `cql/003_logs.cql`.
- **Compaction follows the write pattern.** TWCS everywhere except
  `reactions_by_message`, which uses LCS: it is the only table that is not
  append-only — toggling a reaction is a delete followed by an insert — and
  TWCS would strand tombstones in windows it never recompacts.
- **NULL is forbidden in every primary key column**, clustering included. That
  is why a reaction's identity is a single `emoji_key` text column
  (`'🎉'` or `custom:<uuid>`) rather than two nullable ones.
- **Buckets come from the id's own timestamp, never `new Date()`.** A message
  written late — a retry, a queue that fell behind over a month boundary —
  would otherwise land in the current bucket while its id sorts into the
  previous one, and every read of the correct bucket would miss it silently.
- **A `timeuuid` does not sort correctly as a string.** UUIDv1 lays its
  timestamp out low-bits-first, so a March id can compare greater than an April
  one. Compare `getDate()`.

### `packages/kv` — Redis / Valkey

Presence, typing, voice rosters, rate limiting and pub/sub fan-out.

| Key | Type | Life |
|---|---|---|
| `user:status:{id}` | Hash | 60 s, renewed by heartbeat |
| `user:sockets:{id}` | Set | with the status key |
| `user:socket:{u}:{s}` | String | per-socket liveness |
| `channel:typing:{c}:{u}` | String | 8 s, strict |
| `voice:channel:{c}:members` | Hash | none — a call lasts as long as it lasts |
| `ratelimit:msg:{u}` | ZSET | with the window |

- **The braces are load-bearing.** They are Redis Cluster hash tags:
  `user:status:{u}` and `user:sockets:{u}` land in one slot, which is what lets
  a single Lua script write both. A script spanning slots is *rejected* with
  CROSSSLOT, not merely slowed. `tests/unit/keys.test.ts` computes real
  CRC16/XMODEM slots rather than asserting.
- **A Set cannot expire its members.** `EXPIRE` applies to the whole key, so a
  socket id left by a crashed node would be renewed forever alongside the live
  ones. That is why each socket also gets its own liveness key, and
  `reapDeadSockets` compares the two.
- **Read-then-write goes in Lua.** A sliding window built from client-side
  `ZREMRANGEBYSCORE`/`ZCARD`/`ZADD` leaks under exactly the load it exists to
  stop, and `MULTI` does not help — it batches commands, it does not let a
  decision inside the batch depend on a value read within it.
- **Never make a hot read a keyspace scan.** Typing has an index sorted set
  beside the per-user keys, because "who is typing here" is asked on every
  keystroke in every open channel.

### `packages/auth` — Better Auth

Argon2id at OWASP's parameters (m=19456, t=2, p=1 — 67 ms on an Intel i5-5257U
@ 2.7 GHz), the username plugin, and a Drizzle adapter over `packages/db`.

The desktop and native clients cannot use the session cookie: a packaged
Electron renderer loads from `file://`, whose origin is opaque, and React
Native has no cookie jar. Both use the bearer token instead.

### `packages/env` — T3 Env

One entry point per runtime, because each bundler inlines a different prefix:
`./server`, `./client` (`NEXT_PUBLIC_`), `./native` (`EXPO_PUBLIC_`),
`./desktop` (`VITE_`, schema only), `./shared`, and `./index` — which is
**types only**, so importing it emits no runtime code and runs no schema.

`./desktop` exports a schema and no `createEnv` call, because Vite inlines
`import.meta.env.VITE_*` by literal text substitution at build time: the
expression has to appear, spelled out, in a file Vite itself compiles.

### `packages/ui` — the design system

Base UI primitives with shadcn-style CVA variants, and a Tailwind v4 entry
point that *is* the configuration — `@theme inline` turns each CSS custom
property into a token, so `bg-primary` and `text-foreground` resolve from the
same variables the components read.

### `packages/config` — TypeScript presets

Five JSON files: `base`, and `elysia` / `expo` / `nextjs` / `react-library`
extending it. `base` is where the strictness lives — `strict`,
`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`,
`verbatimModuleSyntax`, `isolatedModules`, `noImplicitOverride` — and every
derived preset inherits the whole set.

---

## Data model

Two datastores, split by shape rather than by fashion.

**Postgres holds the relational graph** — users, guilds, members, roles,
channels, permissions — where foreign keys and transactions earn their cost.

**ScyllaDB holds the message streams** — history, reactions, mentions, audit
and moderation logs — where the write pattern is append-only and the read
pattern is "the last N in this channel".

**Redis holds what is true only right now** — who is online, who is typing, who
is in a call — and every key has a TTL, because a key without one is a leak
that shows up in production months later as memory.

The seam between the first two is
`channel_read_state.last_read_message_id`, which stores a Scylla `timeuuid` and
is deliberately opaque to Postgres. It carries **no foreign key**, and the
unread comparison has to happen in Scylla, because UUIDv1's low-bits-first
layout means a bytewise comparison in Postgres is not chronological.

---

## Testing

568 tests. The split matters more than the total: **427 run on a bare
checkout**, and 141 need a datastore and skip with an instruction when one does
not answer — so `bun run test` is safe anywhere and never silently green for
the wrong reason.

| Package | Unit | Integration | E2E | Needs a server |
|---|---:|---:|---:|---|
| `apps/server` | 39 | 23 | 21 | 4 (Redis) |
| `apps/web` | — | — | 19 | — |
| `apps/native` | — | — | 18 | — |
| `apps/desktop` | 17 | — | 41 | — |
| `packages/db` | 61 | 8 | 16 | 16 (Postgres 18) |
| `packages/chat-db` | 35 | 50 | — | 50 (Cassandra/Scylla) |
| `packages/kv` | 43 | 58 | — | 58 (Redis) |
| `packages/auth` | 1 | 8 | 13 | 13 (Postgres) |
| `packages/env` | — | 36 | — | — |
| `packages/ui` | 6 | — | 23 | — |
| `packages/config` | — | 32 | — | — |

### What "integration" means here

Nothing in these suites simulates the thing under test.

- **`packages/config`** runs the real `tsc`: `--showConfig` for the resolved
  options, so `extends` is applied by the tool that owns those rules, and real
  compiles of real fixtures for the behaviour. `noUnusedLocals` really is a
  compile error (TS6133); `verbatimModuleSyntax` really refuses a value import
  used only as a type (TS1484).
- **`apps/web`** runs `next build`, then `next start`, then fetches. The routes
  prerender static, the linked stylesheet is served with the design tokens in
  it, and an unknown path answers a real 404 rather than a 200 that looks like
  one.
- **`apps/native`** runs `expo export` — no simulator, no Xcode, no Android SDK
  — and reads what Metro produced: the public API URL inlined as a literal, no
  server secret, no `argon2` or `drizzle` anywhere near a React Native bundle.
- **`apps/desktop`** builds the app and then **executes** the main and preload
  bundles with the `electron` module replaced by a fake, so what is asserted is
  the arguments the shipped code passes to Electron rather than the text it was
  written with.
- **`packages/ui`** renders components with `react-dom/server` and compiles
  `globals.css` through the same PostCSS plugin the apps load, then looks up
  every class the component emitted in the resulting stylesheet.
- **`packages/env`** imports each entry point with a controlled environment and
  a fresh module instance per case, because every schema validates at module
  scope and that is the whole contract.
- **`packages/db`, `packages/auth`** talk to a real Postgres 18 through the
  production Neon serverless driver, over a WebSocket→TCP tunnel written for
  the purpose, so the driver under test is the one that ships.
- **`apps/server`** starts a real server and opens a real WebSocket against it,
  with Redis and Postgres faked on purpose — that suite is about the gateway's
  own logic, and 17 of its cases therefore run anywhere. The remaining 4 live
  in `gateway-fanout.test.ts`, which needs a real Redis and **two** server
  processes, because with one node every event is local and the `origin` filter
  that stops a node echoing its own events cannot be observed at all.

### Method

Two habits, applied throughout, and both earned their place by catching
something:

**A passing test is suspect until a mutation breaks it.** Every suite in this
repository was mutation-checked — the thing it claims to protect was
deliberately broken, and the suite had to fail. Four separate assertions turned
out to prove nothing and were rewritten to say what was actually true:
`@source "../components"` and `@source "."` are not what make Tailwind find the
components, `transpilePackages` is not what compiles the workspace packages
under Turbopack, and `experimental.optimizeCss` is not what downlevels the
oklch palette.

**Never assert on the clock.** Three flaky tests were fixed by removing time
bets rather than by widening tolerances. The rate limiter's `retryAfterMs` is
now bracketed from the test's own measurements — legitimate, because both
halves of that value come from the client's clock — and the heartbeat tests
wait for a condition instead of sleeping. Verified by twelve runs under eight
CPU load processes.

---

## What the tests found

Every item below is a real defect that shipped in the working tree and was
caught by writing the test, not by reading the code.

**A packaged desktop build pointed its CSP at localhost.** The main process
built `connect-src` from an origin it read out of `process.env` — which Vite
does not substitute; only `import.meta.env` is compiled in. A packaged app is
launched from Finder or Explorer with no shell environment, so every installed
build would have blocked the real API and the gateway socket, while
`bun run dev` inherited the developer's shell and looked correct throughout.

**A Client Component can read server env, and the build will not stop it.** A
`"use client"` file importing `@repo/env/server` compiles, and the value is
rendered into `.next/server/app/<route>.html` — the file every visitor
downloads. T3 Env's guard is `typeof window`, and during a prerender a Client
Component runs on the *server*, so the guard sees a server and hands the value
over. It never reaches a JS chunk, so a leak check that searched only
`.next/static` would report success.

Closed in three layers, because no single one covers every bundler.

`@repo/env`'s `exports` map sends the `browser` and `react-native` conditions to
a module that throws, keeping the server schema out of the Electron renderer and
the React Native bundle entirely — measured with a forbidden import in each. It
cannot close the Next path, and no export map can: a Client Component's SSR pass
resolves `default`, the same condition Bun, drizzle-kit and `next.config.ts`
need.

For Next, `apps/web/lib/env.ts` carries `import "server-only"`. Next treats that
as a compiler marker rather than a module — *"the contents of these packages
from NPM are not used"* — so a Client Component reaching it is a **build
error**, measured. The marker cannot live in `@repo/env`: outside Next the npm
package really executes and throws, which would take the API and the migrations
down with it. `apps/web/biome.jsonc` forbids the unguarded import under `app/**`
and `components/**` so the guarded entry is not merely available but required,
and `apps/web/tests/e2e/bundle.test.ts` builds both shapes and asserts the
contrast: one fails, the other still leaks.

**A session token could not travel as a WebSocket subprotocol.** Better Auth
issues padded base64, which ends in `=`; a subprotocol is an RFC 7230 `token`,
whose charset excludes it, and the browser throws before the socket opens.
Every unit test on both sides had used a fabricated token that happened to fit.

**`bun install` broke the Expo CLI outright.**
`@babel/helper-compilation-targets` gets its own copy of `lru-cache@5`, which
wants `yallist@^3`, and Bun places that copy without a nested `yallist` — so it
resolves the hoisted `yallist@5`, whose export is not a constructor. Every
`expo` command died with `Yallist is not a constructor`, which is why nothing
in that app had ever run. Bun's `overrides` are flat and its nested
`resolutions` are ignored, so the fix is the root `yallist@3.1.1`
devDependency: a direct dependency wins the hoist, and `tar` — the only package
that actually wants v5 — gets its own nested copy.

**A sandboxed preload cannot be an ES module.** This package is
`"type": "module"`, so the default output was `index.mjs`, which a sandboxed
renderer fails to load *silently*: no bridge, no error, and the app falls back
to in-memory credentials, signing the user out on every restart.

**The renderer shipped unminified** — 1,566 kB against 669 kB. electron-vite
leaves it that way by default, unlike plain Vite, and nothing in the build
output says so.

**An `exhausted` flag was inverted.** A full page of message history reported
`exhausted: true`, so a caller paginating on it would have truncated history at
the first complete page. Renamed `boundReached`.

**`getMessageMentions` cast `Uuid[]` as `string[]`.** The values were driver
objects, so a role-mention badge would never have lit up.

**Metro's transform cache does not key on the inlined `EXPO_PUBLIC_*` value.**
Change the API URL and rebuild — even from a fresh process — and the old value
still ships. Clearing the cache is not optional.

**A test that skipped forever.** A run killed before its `afterAll` left
`apps/native/.env.development` behind, and the test skipped whenever that file
existed so it could never clobber a developer's own. It was gitignored, so
nothing noticed. It now matches on the file's *contents*: residue it wrote is
reclaimed, anything else is still left untouched.

---

## What has never run

Stated plainly, because a claim that something works when it has only been
type-checked is worse than saying nothing — it removes the reason to check.

- **The realtime gateway, end to end.** Its unit and e2e suites pass against a
  real Redis, but no browser has ever connected. Proving the cross-node fan-out
  needs **two** server processes: with one node the `origin` filter is
  untestable, because every event is local.
- **The desktop app's window.** Electron 44 requires macOS 13+ and the machine
  this was written on is 12. The tests execute the main and preload bundles,
  which is not the same as Electron executing them.
- **The native app on a device.** `expo export` proves the bundle; native
  modules, permissions and the Keychain need hardware.
- **ScyllaDB itself.** The CQL was verified against Apache Cassandra 5.0.9,
  which is the engine Scylla maintains compatibility with — Scylla-specific
  behaviour is not covered. `bun run validate:cql` points the same suite at a
  real Scylla.
- **Voice.** The schema, the Redis rosters and the gateway frames exist. There
  is no media layer.

[SETUP-WINDOWS.md](SETUP-WINDOWS.md) has an ordered list of what to verify
first, and why that order. [ROADMAP.md](ROADMAP.md) has what the project needs
next, in dependency order — starting with the fact that the write path does not
exist yet: `@repo/chat-db` is imported by nothing, and twelve of the fourteen
Postgres tables have no consumer.

---

## Getting started

**On Windows 11, start with [SETUP-WINDOWS.md](SETUP-WINDOWS.md).**

```bash
bun install

for d in apps/server apps/web apps/native apps/desktop packages/db packages/auth; do
  cp $d/.env.example $d/.env
done

bun run db:migrate
bun run dev
```

Generate a real secret with `openssl rand -base64 32`. The value in
`.env.example` is a placeholder that exists only to satisfy the schema's
`min(32)` — and `packages/env`'s test suite fails if anyone replaces it with
something that looks generated.

The datastores, for the suites that need them:

```bash
cd packages/kv      && bun run kv:up          # Valkey on 6379
cd packages/chat-db && bun run validate:cql   # throwaway Scylla, applies cql/
```

---

## Commands

```bash
bun run dev             # every app, through turbo
bun run dev:server      # or one of them: server, web, native, desktop

bun run lint            # Biome across the repo, one pass
bun run lint:fix
bun run check-types     # tsc per package, through turbo

bun run test            # unit + integration + e2e, per package
bun run test:unit
bun run test:integration
bun run test:coverage
bun run bench           # mitata suites in db, auth and server

bun run security:check  # bun audit, gated at high severity
bun run db:generate     # drizzle-kit
bun run db:migrate
bun run db:studio
```

Two commands that do not exist and are worth knowing about: **`bun bench`** is
not a Bun subcommand — typing it silently runs the npm script — and there is no
`auth migrate`; Better Auth's schema comes from the codemod described above.

---

## Conventions

**No `any`, and none of its disguises** — not `as any`, not `as unknown as T`
used to silence rather than narrow, not an untyped `catch` binding used as a
value. `unknown` at a boundary is correct and expected: everything crossing a
wire arrives as `unknown` — Redis replies, CQL rows, pub/sub payloads, IPC
messages — and is narrowed once, at the edge, in the module that owns the wire.

**Casts carry a comment saying why.** Three in this repository are legitimate,
and they share a shape: the value really is what the cast says and TypeScript
has no way to know.

**Suppressions are documented or refused.** Every rule turned off in
`biome.jsonc` has a written, measured reason — `noUnnecessaryConditions` is off
because it cost ~100 s across the repo and found nothing in 108 files;
`noAwaitInLoops` is off only in the paths where the loop is sequential by
nature.

**Comment the decision, not the mechanics.** `// increment i` is noise; the
reason a Set has a per-member liveness key beside it is not.

**One Biome config, at the root.** A nested config *replaces* `files.includes`
rather than merging, which once left two whole packages reporting "Checked 0
files" while `lint` stayed green.

**Every pull request gets its own database.**
`.github/workflows/preview-db.yml` creates a schema-only Neon branch, migrates
it, and deletes it on close.

**One accepted CVE**, with its reachability analysis written out in
[SECURITY-EXCEPTIONS.md](SECURITY-EXCEPTIONS.md). Never add a second without
adding that analysis.
