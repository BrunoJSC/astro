# Running astro on Windows 11

This repository was written on a borrowed macOS 12 machine with no Docker and no
Rust. Most of it has never been executed — the exceptions are `@repo/kv`, whose
Lua was verified against a Redis built from source, and the desktop app's
credential storage. Windows 11 is where
that changes — every blocker below is a limitation of the machine it was written
on, not of the code.

Read [What to verify first](#what-to-verify-first) before building features. It
is ordered, and the order matters.

---

## Prerequisites

| Tool | Why | Install |
| --- | --- | --- |
| **Git** | — | `winget install Git.Git` |
| **Bun ≥ 1.2** | package manager, test runner, and the API's runtime | `powershell -c "irm bun.sh/install.ps1 \| iex"` |
| **Docker Desktop** | Valkey and ScyllaDB. **Use the WSL2 backend** — both images are Linux-only and the Hyper-V backend cannot run them | [docker.com](https://www.docker.com/products/docker-desktop/) |
| **Neon account** | Postgres. There is no local Postgres in this setup | [neon.tech](https://neon.tech) |

Node is not required. Bun runs everything.

### Two Windows settings worth changing before cloning

```powershell
# node_modules in a monorepo goes deep, and the classic 260-character limit
# produces install errors that look like corruption.
git config --system core.longpaths true
```

Enable **Developer Mode** (Settings → System → For developers). Workspace links
need symlink creation, and without it `bun install` can fail on the
`workspace:*` dependencies.

Leave `core.autocrlf` alone — the repo has no `.gitattributes`, and Biome
formats with LF. If you see the whole tree show as modified after cloning,
that is why: `git config core.autocrlf input`.

---

## Setup

```powershell
git clone https://github.com/BrunoJSC/astro.git
cd astro
bun install
```

### Environment files

Each app loads its own `.env`. A root `.env` does **not** configure them — Bun
reads `.env` from the current directory only and does not walk up, and turbo
runs in strict env mode, so each task receives only the variables its `env`
array declares.

```powershell
copy apps\server\.env.example   apps\server\.env
copy apps\web\.env.example      apps\web\.env
copy apps\desktop\.env.example  apps\desktop\.env
copy packages\db\.env.example   packages\db\.env
copy packages\auth\.env.example packages\auth\.env
```

Then fill in the three that have no working default:

| Variable | Where it goes | Value |
| --- | --- | --- |
| `DATABASE_URL` | server, web, db, auth | Neon's **pooled** connection string (host ends in `-pooler`), keep `?sslmode=require` |
| `DIRECT_URL` | server, db | Neon's **direct** string — drizzle-kit only. Neon's pooler is PgBouncer in transaction mode, where DDL and advisory locks do not behave |
| `BETTER_AUTH_SECRET` | server, web, auth | 32+ characters. `bun -e "console.log(crypto.randomBytes(32).toString('base64'))"` |

`.env.example` at the repo root lists every variable the workspace validates,
with the reasoning for each.

### Start the databases

```powershell
cd packages\kv
bun run kv:up          # Valkey on 6379, plus a cluster-enabled one on 6380
                       # that exists only so CLUSTER KEYSLOT answers

cd ..\chat-db
docker compose up -d --wait   # ScyllaDB on 9042 — first pull is ~400MB
```

Then load the CQL schema. `validate.sh` is bash and will not run under
PowerShell — use **Git Bash**, which ships with Git for Windows:

```bash
cd packages/chat-db && bun run validate:cql
```

Postgres migrations go to Neon:

```powershell
bun run db:migrate
```

---

## Running

Four processes, four terminals. Ports:

| Port | What |
| --- | --- |
| 3000 | web (Next.js) |
| 3001 | server (Elysia API + `/gateway` WebSocket) |
| 5173 | desktop renderer dev server |
| 6379 | Valkey |
| 6380 | Valkey, cluster-enabled — slot checks only |
| 9042 | ScyllaDB |

```powershell
bun run dev:server     # start this first — everything else talks to it
bun run dev:web
bun run dev:desktop
```

Windows Defender will prompt to allow each listener on first run. Allow on
private networks only.

---

## What to verify first

Ordered so a failure in one does not mask the next. Only step 1 has ever been
executed; the rest is the backlog.

### 1. The Lua in `@repo/kv` — re-run, do not re-verify

Already executed against a real Redis 7.2.5, on macOS: 58 integration tests
over presence, dead-socket reaping, typing, the sliding window, voice rosters
and pub/sub, plus hash-tag co-location answered by `CLUSTER KEYSLOT`.

```powershell
cd packages\kv
bun run validate:kv
```

That starts both Valkey containers and runs the suite. It is cross-platform —
no Git Bash needed — and the suite **skips** with an instruction when no server
answers, so it is safe to run before Docker is up.

What to watch for is a difference from macOS, not a first result: Valkey rather
than Redis, and a Windows Docker network in front of it.

### 2. The CQL in `@repo/chat-db`

Never applied to a live node. In Git Bash:

```bash
cd packages/chat-db && bun run validate:cql
```

Watch for one line: `PASS  null in a clustering column is rejected`. The
reactions table exists in its current shape *because* of that rule. If it ever
reports FAIL, the single-column `emoji_key` design has stopped being load-bearing
and the long comment in `cql/004_reactions_mentions.cql` is stale.

### 3. The gateway, with TWO server processes

This is the one that cannot be faked. With a single node, an `origin` filter
that drops everything and one that drops nothing look identical, because every
event is local — both opposite bugs are invisible.

```powershell
bun run dev:server
# second terminal, from apps\server:
$env:PORT=3002; bun run dev
```

Connect a client to each, join both to the same channel, send `typing.start` on
one. It must appear on the other.

Then in `valkey-cli` (`cd packages\kv; bun run kv:cli`):

- `SMEMBERS user:sockets:{<id>}` grows when a second tab opens
- `TTL user:status:{<id>}` returns to ~60 on each heartbeat
- Ctrl-C the server and the key disappears immediately rather than expiring

### 4. The desktop app

**This is where Windows is better than the machine it was written on.** Electron
44 does not launch on macOS 12 — it references `SMAppService`, which is macOS
13+ — so `bun run dev` was never executed. On Windows 11 it should simply work.

```powershell
bun run dev:desktop
```

The window's panel shows five rows. Expect:

| Row | Expected on Windows |
| --- | --- |
| API | `ok`, once the server is running |
| Session | `signed out` — there is no sign-in screen yet |
| Gateway | `closed` — it only connects once there is a session |
| Credentials | `safeStorage (encrypted)` |
| Runtime | `electron / win32` |

The credential storage was verified on macOS — Keychain, ciphertext on disk,
token absent in plaintext. On Windows the same code path goes through **DPAPI**,
and `credentials.backend()` should report exactly that.

### 5. An installer

Never produced.

```powershell
cd apps\desktop
bun run build:app
```

Two things will come up:

- Bun blocks `electron-winstaller`'s postinstall script, and the NSIS target
  needs it. `bun pm untrusted` lists it; add `electron-winstaller` to
  `trustedDependencies` in the root `package.json` if you want the installer.
- The build is unsigned. Windows SmartScreen will warn on a downloaded `.exe`
  until it is signed with a code-signing certificate.

---

## Windows-specific notes

**One `.sh` script needs Git Bash or WSL.**
`packages/chat-db/scripts/validate.sh` is the only bash left in the repo — it
drives `docker compose exec` to load CQL and has no equivalent yet. The kv one
is gone: its assertions became `packages/kv/tests/integration/`, and
`validate:kv` is now plain `docker compose` plus `bun test`.

**Everything else in `package.json` is cross-platform.** Bun uses its own shell
for `bun run` scripts on Windows, so `rm -rf` in the `clean` scripts works
without `rimraf` or `cross-env`.

**Git hooks work.** Lefthook installs native hooks; `bun install` runs
`lefthook install` through the `prepare` script.

**Docker Desktop must use WSL2.** ScyllaDB and Valkey images are Linux-only.
Under the Hyper-V/Windows-containers backend they will not start at all.

**Native and mobile.** `apps/native` is Expo. iOS needs macOS; Android works on
Windows with Android Studio. Neither has been run.

---

## What is still genuinely unbuilt

Not blockers, just honesty about the state:

- **No sign-in screen anywhere.** Better Auth is wired on the server and in all
  three clients, but nothing renders a form. The desktop shows `signed out`
  because that is true, not because something is broken.
- **No UI.** No guild rail, channel list, message view or composer. `apps/web`
  and `apps/desktop` are both shells.
- **DM channels cannot be subscribed to.** `channels.guild_id` is null for a DM
  and there is no participant table, so the gateway denies them — deliberately,
  since allowing them would let any authenticated user subscribe to any DM by
  id. Needs a `channel_recipients` table.
- **No auto-update on desktop.** Electron ships Chromium, so its CVEs are now
  the app's responsibility. `electron-updater` pairs with the
  `electron-builder.yml` already in the repo.
- **Voice is schema only.** `voice.join`, `peerId` and `selfMute` exist in
  Postgres, Redis and the gateway. No WebRTC, no `desktopCapturer` wiring — and
  those were the reason for moving to Electron in the first place.
