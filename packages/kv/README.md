# @repo/kv

Redis/Valkey: presence, typing indicators, voice state, rate limiting, and the
pub/sub bus that lets several WebSocket nodes act like one.

Everything here is ephemeral by design. Postgres holds the relational graph and
ScyllaDB holds message history; this package holds the state that is worthless a
second late and should not survive a restart.

---

## Verified against a real server

The Lua in `src/scripts.ts` runs, and `tests/integration/` is what proves it —
58 tests over presence, reaping, typing, the sliding window, voice rosters and
pub/sub, plus hash-tag co-location answered by `CLUSTER KEYSLOT` rather than by
our own CRC16.

```bash
bun run validate:kv     # starts Valkey, runs the suite
bun test tests/unit     # no server needed
```

The integration suite **skips**, with an instruction, when no server answers —
so it is safe to run anywhere.

The split is deliberate. The unit tests use a fake client and do **not**
reimplement the scripts, because a test of a reimplementation tests the
reimplementation; the integration tests run the real thing, and are the only
place concurrency is observable at all.

---

## The braces in the keys are load-bearing

```
user:status:{01931f4c-…}
user:sockets:{01931f4c-…}
user:socket:{01931f4c-…}:sock-1
channel:typing:{01931f4c-…}:{user}      ← tagged by CHANNEL, not user
voice:channel:{01931f4c-…}:members
ratelimit:msg:{01931f4c-…}
events:guild:{01931f4c-…}
```

They are not placeholders left in by mistake. In Redis Cluster a `{…}` group is
the **hash tag**: only the text inside it is hashed to pick a slot. So all three
presence keys for one user land on the same node, which is what lets
`PRESENCE_TOUCH` write to them in a single Lua script — a script whose keys span
slots is rejected outright with `CROSSSLOT`, not merely slowed down.

Redis reads only the *first* brace group, which is why `channel:typing:{c}:{u}`
is tagged by the channel: the per-user key and the channel's index share a slot.

On a single node the braces are ordinary characters and cost nothing.
`tests/unit/keys.test.ts` reimplements Redis's CRC16/XMODEM slot function and
asserts the co-location, including a control case proving the keys *would*
scatter without the tags.

## Data types

| Key | Type | Lifetime |
| --- | --- | --- |
| `user:status:{u}` | Hash | 60s TTL, renewed by heartbeat |
| `user:sockets:{u}` | Set | 60s TTL, renewed by heartbeat |
| `user:socket:{u}:{s}` | String | 60s TTL, per socket |
| `channel:typing:{c}:{u}` | String | 8s TTL, strict |
| `channel:typing:{c}` | Sorted set | 16s TTL, index |
| `voice:channel:{c}:members` | Hash | none — until everyone leaves |
| `ratelimit:msg:{u}` | Sorted set | window length |

Two of those are not in the original design, and both exist to fix something the
specified shape cannot do on its own.

### `user:socket:{u}:{s}` — because a Set cannot expire members

`user:sockets:{u}` is a Set, and `EXPIRE` applies to the whole key. So as long
as *any* socket keeps heartbeating, the TTL keeps being renewed — including for
a socket id left behind by a node that crashed. The user shows as online from a
laptop that has been shut for a week, and waiting does not fix it, because
something genuinely is still alive.

The liveness key gives each socket its own clock. The Set stays the roster;
`reapDeadSockets` compares the two and drops what no longer exists. It is cheap
enough to run on every heartbeat — the work is proportional to one user's device
count, not to the keyspace — and `startHeartbeat` does exactly that.

### `channel:typing:{c}` — because the per-user key cannot be queried

The 8-second string is a good design for *stopping*: nothing has to fire, no
node holds a timer, and a crash cannot leave someone typing forever. It is
unusable for *reading*. Finding those keys means matching
`channel:typing:{c}:*`, and both ways of doing that are unacceptable on a hot
path — `KEYS` blocks the server for the length of the whole keyspace, and `SCAN`
walks every key in the database for an answer needed on every keystroke in every
open channel.

So the string stays authoritative for expiry, and a sorted set scored by expiry
time indexes it. Reading is one `ZRANGEBYSCORE`, and lapsed entries are pruned
as part of that read.

## Why the multi-key operations are Lua

A sliding-window limiter written as `ZREMRANGEBYSCORE` / `ZCARD` / `ZADD` from
the client leaks under exactly the load it exists to stop: two sockets both read
a count under the limit and both add. `MULTI` does not fix it — it batches
commands, it does not let a decision inside the batch depend on a value read
within it. Lua runs on the server, single-threaded, start to finish.

The same reasoning covers dropping the last socket: `SREM`, `SCARD` and `DEL`
have to see one consistent view, or a reconnect racing a disconnect deletes the
presence of a user who is still online.

One detail in the limiter is easy to miss. Every attempt writes a **random**
ZSET member. A ZSET member is unique, so two sends in the same millisecond
written under the same member would collapse into one entry and count once —
letting a client exceed the limit by being fast enough, which is the precise
thing being defended against. The harness tests this with six concurrent takes.

## Pub/sub is a hint, never the only copy

Redis pub/sub is fire-and-forget. A node that is disconnected when an event is
published does not receive it on reconnect: there is no backlog, no offset, no
acknowledgement. That is the right trade for presence and typing, which are
worthless late, and the wrong one for message delivery.

Messages survive because they are written to ScyllaDB *before* being published,
so a client that missed the event still gets the message on its next read.

Two things the transport forces:

- **A separate connection for `SUBSCRIBE`.** Under RESP2 a subscribed
  connection accepts only subscribe, unsubscribe and ping. Under RESP3 — which
  ioredis negotiates by **default** against Redis 6+ — that restriction is gone;
  both are measured in `tests/integration/events.test.ts`. The split stays
  anyway: `enableOfflineQueue` must differ between the two roles (commands fail
  fast, subscriptions queue through a reconnect), and a busy fan-out would
  otherwise sit in front of every command sharing the socket.
  `createKvSubscriber` produces the right one; `getKvConnections` returns both.
- **An `origin` on every payload.** A node subscribes to the channels it also
  publishes on, so without filtering its own events it delivers each one twice
  to the sockets attached to it.

## Usage

```ts
import { getKvConnections, startHeartbeat, takeMessageSlot } from "@repo/kv";

const { commands, subscriber } = await getKvConnections({ url: env.REDIS_URL });

// On socket open — stop() also drops the socket, so a clean close does not
// wait out the TTL.
const heartbeat = startHeartbeat(commands, {
  socketId,
  userId,
  onError: (error) => log.warn({ error }, "heartbeat failed"),
});

// Before accepting a message.
const budget = await takeMessageSlot(commands, userId);
if (!budget.allowed) {
  return reject(budget.retryAfterMs);
}

// On socket close.
await heartbeat.stop();
```

`touchPresence` and `dropPresence` both return the live socket count, and that
number is the whole online/offline protocol: `1` from a touch means this was the
user's first connection and the transition is worth publishing; `0` from a drop
means they really went offline. Publishing on any other value is the bug that
makes someone vanish from the member list because they closed one tab.

## Presence absent ≠ presence offline

`getPresence` returns `null` when nothing is connected. That is *not* the same
as `state: "offline"`, which means the user chose to appear offline and is still
connected and still receiving events. `getPresences` leaves unknown users out of
the map entirely rather than mapping them to `null`, so the two cannot be
confused by accident.

## Commands

```bash
bun test                  # 43 unit tests, no server needed
bun run validate:kv       # start Valkey, run every Lua script, tear down
bun run kv:up             # just start the server
bun run kv:cli            # valkey-cli against it
bun run kv:down           # stop and remove it
```
