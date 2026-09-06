---
paths:
  - "apps/server/**"
  - "apps/desktop/electron/**"
  - "packages/auth/**"
  - "packages/db/**"
  - "packages/kv/**"
  - "packages/chat-db/**"
  - "packages/env/**"
  - "**/*.env.example"
---

# Security and audit

## Dependencies

`bun run security:check` before adding any dependency and before reporting any
task complete. It runs `bun audit --audit-level=high` with three ignores.

Those three are accepted, not forgotten. `SECURITY-EXCEPTIONS.md` records each
with a reachability analysis — for example the `adm-zip` HIGH reached through
`cassandra-driver`, traced to `lib/datastax/cloud/index.js`, whose `init()`
returns at `if (!options.cloud) return;` before `parseZipFile()` is ever
called. **Never add a fourth ignore without writing that analysis.** An ignore
list nobody can justify is an audit that does nothing.

## Secrets

No key, token, connection string or password in tracked files, ever — including
tests, fixtures, comments and commit messages.

This has already happened here: a gitignored `apps/server/.env` holding two live
Neon connection strings was found during a pre-push scan. Scan before the first
push of anything, and mask connection strings in any output.

`.env.example` files carry placeholders only. A public prefix
(`NEXT_PUBLIC_`, `EXPO_PUBLIC_`, `VITE_`) means the value is compiled into a
client bundle and readable by anyone who unpacks it. Never put a secret behind
one.

## Session validation on the server

Every protected route mounts `authPlugin` and checks `user` before doing work.
The plugin is named, so Elysia deduplicates it — mounting it in three modules
registers one lifecycle hook.

Two things the gateway learned the hard way, and both generalise:

**Authenticated is not authorised.** `subscribe` takes an id chosen by the
client. Without the `guild_members` check in
`apps/server/src/modules/gateway/authorize.ts`, any signed-in user could
subscribe to any guild and receive every message in it. Any handler that takes
an id from the client needs the equivalent check.

**Fail closed.** DM channels have `guild_id = null` and there is no participant
table, so nothing in Postgres says who belongs to a DM. `canAccessChannel`
therefore **denies** them. Denying a legitimate user is a bug report; allowing
an illegitimate one is an incident.

**A long-lived connection needs re-validation.** Elysia's Bun adapter snapshots
the context once at upgrade, so `ws.data.user` is the session as it was when the
socket opened and is never refreshed. `startSessionWatch` re-runs `getSession`
on the heartbeat interval. A *failed* lookup must not close the socket — only an
explicit "no session" — or one database hiccup disconnects every client on the
node at once.

## Injection

**SQL.** Use Drizzle's query builder or its `sql` template tag, which
parameterises. Never build a statement by string concatenation. `sql.raw` is
for identifiers you control, never for user input.

**CQL.** Every statement in `packages/chat-db` and `packages/kv` is prepared
with `?` placeholders. Prepared statements are not only about injection here —
an unprepared statement also cannot be routed by token, so the driver picks a
coordinator at random and pays an extra hop.

**Lua.** Keys and arguments go through `KEYS`/`ARGV`. Never interpolate a value
into a script body. `PRESENCE_REAP` builds key names inside Lua, which is safe
only because every key shares the `{user_id}` hash tag and the prefix comes from
`userSocketPrefix`, not from a caller.

**Key builders reject unsafe input.** `packages/kv/src/keys.ts` throws on braces
and whitespace in an id, because a brace would close a Cluster hash tag early
and silently move a key to a different slot than its siblings.

## Client input

Inbound WebSocket frames are validated strictly by TypeBox in
`apps/server/src/modules/gateway/model.ts` before a handler sees them; outbound
frames are declared permissively, because they are already typed at the publish
site and duplicating those unions would let them drift. Keep that asymmetry:
strict on what arrives, permissive on what leaves.

The gateway's second untrusted input is the `Sec-WebSocket-Protocol` header. It
is charset-checked against RFC 6455's `token` grammar before reaching Better
Auth. Session tokens travel there rather than in a query string, because URLs
are written to proxy logs, access logs and browser history as a matter of
course.

## Electron

The renderer is untrusted. `apps/desktop/electron/main/index.ts` keeps
`sandbox`, `contextIsolation` and `nodeIntegration: false` explicit even where
they are already the default, so a changed default cannot silently open the app
up.

The bridge in `electron/preload/` exposes named verbs only. **Never expose
`ipcRenderer` or accept a channel name from the renderer** — a renderer that can
name its own channel can invoke every handler the main process registered.

`shell.openExternal` validates the scheme. It hands anything to the platform
handler, including `file://`, `smb://` and Windows schemes that execute; without
the check, "open a link" becomes "run a program".

## Credentials at rest

`safeStorage` on desktop — Keychain on macOS, DPAPI on Windows. **On Linux with
no secret service it silently falls back to a hardcoded password.**
`describeBackend()` reports that honestly and `durability()` returns
`plaintext`, rather than claiming protection that is not there.

Never report a store as encrypted without asking it. The whole reason
`durability()` is asynchronous is that the honest answer is only known after
the OS says which backend it gave you.
