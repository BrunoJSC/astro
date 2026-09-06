# Gateway

The realtime WebSocket, at `/gateway`. It is what makes `@repo/kv` do something:
presence, typing, voice state, and the fan-out that lets N server processes
behave like one.

It does **not** carry message history. Messages are read over HTTP from
ScyllaDB. Redis pub/sub is fire-and-forget — a node that was disconnected when
an event was published never receives it — so events here are invalidation hints
on top of a durable read, never the only copy.

---

## Status: never run against a live server

`tsc` and Biome pass, and 35 unit tests cover the registry, the frame handlers
and the subprotocol parser with fakes. Nothing here has connected to a real
Redis, a real Postgres, or a real browser: this machine has neither Docker nor a
Redis binary.

The verification that matters cannot be done with one process. See
[Verifying](#verifying) — a single node hides both of the bugs the `origin`
filter exists to prevent.

---

## Frames

Client → server. All strictly validated by `model.ts` before a handler runs:
this is the only untrusted input the gateway takes, and every frame either
writes to Redis or publishes to other nodes.

| `op` | Effect |
| --- | --- |
| `ping` | Refreshes presence, replies `pong` |
| `presence.update` | Sets state/custom status, fans out |
| `subscribe` | Joins a guild or channel topic — **authorised** |
| `unsubscribe` | Leaves a topic |
| `typing.start` / `typing.stop` | Typing indicator |
| `voice.join` / `voice.update` / `voice.leave` | Voice roster |

Server → client: `ready`, `pong`, `error`, `subscribed`, `typing`,
`voice.roster`, and `event` — the envelope around anything that arrived over
pub/sub.

Outbound frames are declared **permissively** on purpose. The payloads are
already typed at the publish site by the discriminated unions in `@repo/kv`, and
re-describing those unions in TypeBox would duplicate them, let them drift, and
surface the drift as messages the server refuses to send to its own clients.

## Only transitions are announced

`touchPresence` and `dropPresence` return the live socket count, and that number
is the entire online/offline protocol:

- `1` from a touch → the user's **first** connection. Announce.
- `0` from a drop → their **last** socket. Announce.
- Anything else → they opened or closed one tab. Say nothing.

Getting this wrong is the bug that lights up "came online" every time someone
opens a tab, or makes them vanish from the member list because they closed one.

Presence fans out to `events:user:{id}` — reaching the user's own other devices,
so a status set on the phone shows on the desktop — and to `events:guild:{id}`
for each guild they belong to, which is what a member list renders from. The
guild ids are read **once per connection** and kept on the socket, so the
disconnect path (the one that also runs for every client at once when a node
dies) needs no query.

## One subscription per topic, refcounted

`registry.ts` holds a Redis subscription per topic and a local set of sockets
behind it. The bug this prevents is not a duplicate subscription — `SUBSCRIBE`
twice is idempotent — it is duplicate **delivery**, because each
`subscribeEvents` call adds another `message` listener on the shared connection.
Two members of the same guild on one node would receive every event twice.

Fan-out is a loop over an in-memory `Set`, and the payload is serialised once
for the whole loop rather than per socket.

Every published event carries this node's `origin`. A node subscribes to the
channels it also publishes on, so without the filter it re-delivers its own
events to sockets that were already updated locally.

## Two things about Elysia's `.ws()` worth knowing

`.ws()` registers as an ordinary route — `app.route("WS", path, ...)` — so the
whole lifecycle runs on the upgrade and `authPlugin`'s derive puts the session on
`ws.data`. That is why authentication works at all.

But the Bun adapter then does `data: { ...context }` exactly **once**. `ws.data`
is a frozen snapshot: nothing on it is recomputed, and there is nowhere on it to
hang state that changes while the socket is open. Hence the module-level
`states` map for the heartbeat handle, the typing throttle and the guild ids —
and hence `startSessionWatch`.

Also: the adapter honours `beforeHandle` only when it is a **function**
(`typeof options.beforeHandle == "function"`). An array is ignored silently.

## The session is rechecked every 20 seconds

Because `ws.data` is that snapshot, the session is the one captured at upgrade
and is never refreshed. Without a recheck, a socket keeps streaming events after
the user logs out, changes their password, or revokes the session from another
device — until they happen to disconnect, which may be days.

`startSessionWatch` re-runs `auth.api.getSession` on the heartbeat's own
interval, so the exposure window is bounded by the same number that bounds
presence staleness. A **failed** lookup does not close the socket; only an
explicit "there is no session" does. Otherwise a blip in Postgres would
disconnect every client on the node at once and turn a database hiccup into a
thundering reconnect.

## Rate limiting

Frames that publish without natural coalescing — `presence.update`, `voice.*` —
spend one slot of the user's `ratelimit:msg` budget. That budget is shared with
sending a message on purpose: both are the same user writing, and a client
should not get a fresh allowance by switching from one to the other.

Typing is the exception and never reaches the limiter. It is throttled in
process, per channel, to one publish every 3 seconds — the Redis key lives 8
seconds, so re-publishing every 3 keeps the indicator alive with room to spare,
and the keystrokes in between cost nothing.

## Known gaps

**DM channels cannot be subscribed to.** `channels.guild_id` is null for a DM and
there is no participant table, so nothing in Postgres says who is in a given DM.
`canAccessChannel` therefore **denies** them. This fails closed deliberately:
allowing them would let any authenticated user subscribe to any DM by id.
Unblocking it needs a `channel_recipients (channel_id, user_id)` table and one
more branch in `authorize.ts`.

**Native cannot connect yet.** React Native has no cookie jar either, and would
use the same bearer path the desktop now uses -- see below. Nothing wires it.

## Two ways in

A browser sends its session cookie on the upgrade automatically, and
`authPlugin`'s derive resolves it before `open` runs. That is `apps/web`.

A Tauri window cannot: it is served from `tauri://localhost`, so the API's
cookie is third-party to it and both WKWebView and WebView2 block those by
default. So it authenticates with a bearer token instead, and the token travels
as a **WebSocket subprotocol** -- `new WebSocket(url, ["bearer", token])` --
because `Sec-WebSocket-Protocol` is the only client-controlled header the
WebSocket API exposes. `Authorization` cannot be set on a WebSocket at all.

Not a query string, which is what most tutorials show. URLs are written to proxy
logs, access logs and browser history as a matter of course, and a session token
in any of those is a session token leaked. Headers are not routinely logged.

`authenticate.ts` owns this. The cookie wins when both are present, so a browser
cannot widen its own identity by also offering a token, and the subprotocol
value is charset-checked against RFC 6455's `token` grammar before it is handed
to Better Auth. The marker is echoed back in the upgrade response -- browsers
fail the connection when the server selects a protocol that was not offered.

The credential also decides how the session is rechecked: a cookie socket
revalidates the cookie, a bearer socket revalidates the token. `clientType` in
presence follows from it too, so a desktop client no longer reports as `"web"`.

This needs `bearer()` registered in `@repo/auth`, which it now is. It changes
nothing for the web app: the plugin's hooks only engage when an Authorization
header is present.

## Verifying

Unit tests need nothing:

```bash
cd apps/server && bun test tests/unit
```

The integration check needs Redis, Postgres, and — critically — **two** server
processes:

```bash
cd packages/kv && bun run kv:up          # Valkey on 6379
cd ../../apps/server && bun run dev      # node A on 3001
PORT=3002 bun run dev                    # node B
```

Connect a client to each, join both to the same channel, send `typing.start` on
one. It must appear on the other. With a single node this proves nothing: an
`origin` filter that drops everything and one that drops nothing both look
identical, because every event is local.

Then, in `valkey-cli`:

- `SMEMBERS user:sockets:{<id>}` grows when a second tab opens.
- `TTL user:status:{<id>}` returns to ~60 on each beat.
- Ctrl-C the server: the key disappears immediately rather than expiring in 60s.
