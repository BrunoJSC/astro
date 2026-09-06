/**
 * Exercises every Lua script against a real server.
 *
 * The unit tests deliberately stop at the wire: they check which keys are built
 * and how replies are parsed, using a fake client. What they cannot check is the
 * half that matters most -- the scripts themselves, which run inside Redis and
 * are the reason every atomicity claim in this package holds. That is what this
 * does, and it goes through the package's own exported functions rather than raw
 * commands, so a bug in a wrapper fails here too.
 *
 * Run with `bun run validate:kv`, which starts the server first.
 */
import {
  closeKvConnections,
  createKvClient,
  createKvSubscriber,
  dropPresence,
  getPresence,
  getTyping,
  getVoiceMembers,
  joinVoice,
  leaveVoice,
  publishEvent,
  type RateLimitResult,
  reapDeadSockets,
  resetMessageBudget,
  startTyping,
  stopTyping,
  subscribeEvents,
  sweepVoiceChannel,
  takeMessageSlot,
  touchPresence,
  updateVoiceState,
  userSocketKey,
  userSocketsKey,
  userStatusKey,
  voiceMembersKey,
} from "../src/index";

const URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const USER = "01931f4c-8d2a-7000-8000-0000000000a1";
const OTHER = "01931f4c-8d2a-7000-8000-0000000000a2";
const CHANNEL = "01931f4c-8d2a-7000-8000-0000000000b1";
const GUILD = "01931f4c-8d2a-7000-8000-0000000000c1";

const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const CYAN = "\u001b[36m";
const RESET = "\u001b[0m";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    process.stdout.write(`  ${GREEN}PASS${RESET}  ${label}\n`);
    return;
  }
  failed += 1;
  process.stdout.write(`  ${RED}FAIL${RESET}  ${label}\n`);
  if (detail !== undefined) {
    process.stdout.write(`        ${JSON.stringify(detail)}\n`);
  }
}

function section(title: string): void {
  process.stdout.write(`\n${CYAN}==> ${title}${RESET}\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const client = createKvClient({ url: URL });
await client.connect();
const subscriber = createKvSubscriber(client);
await subscriber.connect();

// A clean slate, so a previous run cannot make this one pass.
await client.del(
  userStatusKey(USER),
  userSocketsKey(USER),
  userSocketKey(USER, "sock-1"),
  userSocketKey(USER, "sock-2")
);
await resetMessageBudget(client, USER);
await stopTyping(client, CHANNEL, USER);
await leaveVoice(client, CHANNEL, USER);
await leaveVoice(client, CHANNEL, OTHER);

/* ------------------------------------------------------------------ */
section("Presence");

const first = await touchPresence(
  client,
  { socketId: "sock-1", userId: USER },
  { clientType: "desktop", state: "online" }
);
check("first connection reports 1 socket", first === 1, first);

const second = await touchPresence(client, {
  socketId: "sock-2",
  userId: USER,
});
check("second device reports 2 sockets", second === 2, second);

const presence = await getPresence(client, USER);
check(
  "fields round-trip through the hash",
  presence?.state === "online" && presence.clientType === "desktop",
  presence
);
check(
  "last_active comes back as a number",
  typeof presence?.lastActive === "number"
);

const statusTtl = await client.ttl(userStatusKey(USER));
const socketsTtl = await client.ttl(userSocketsKey(USER));
check(
  "both keys carry a TTL, so a dead node self-heals",
  statusTtl > 0 && socketsTtl > 0,
  { socketsTtl, statusTtl }
);

/* ------------------------------------------------------------------ */
section("Dead socket reaping");

// Simulate a node that died: its liveness key expires, but the set member it
// left behind is renewed forever by the user's other device.
await client.del(userSocketKey(USER, "sock-2"));
await touchPresence(client, { socketId: "sock-1", userId: USER });

const before = await client.scard(userSocketsKey(USER));
check("the orphan survives a heartbeat on its own", before === 2, before);

const reaped = await reapDeadSockets(client, USER);
check(
  "the reaper removes exactly the dead one",
  reaped.removed === 1 && reaped.remaining === 1,
  reaped
);

/* ------------------------------------------------------------------ */
section("Clean disconnect");

await touchPresence(client, { socketId: "sock-2", userId: USER });
const remaining = await dropPresence(client, {
  socketId: "sock-2",
  userId: USER,
});
check("closing one tab leaves the user online", remaining === 1, remaining);
check(
  "presence survives while another socket holds it",
  (await getPresence(client, USER)) !== null
);

const last = await dropPresence(client, { socketId: "sock-1", userId: USER });
check("the last socket reports zero", last === 0, last);
check(
  "presence is gone, not merely marked offline",
  (await getPresence(client, USER)) === null
);

/* ------------------------------------------------------------------ */
section("Typing");

await startTyping(client, CHANNEL, USER, 400);
const typing = await getTyping(client, CHANNEL);
check("the index answers who is typing", typing.length === 1, typing);
check("with an expiry in the future", (typing[0]?.expiresAt ?? 0) > Date.now());

await sleep(500);
const lapsed = await getTyping(client, CHANNEL);
check(
  "and stops on its own, with nothing to fire",
  lapsed.length === 0,
  lapsed
);

await startTyping(client, CHANNEL, USER, 8000);
await stopTyping(client, CHANNEL, USER);
check(
  "an explicit stop clears the index too",
  (await getTyping(client, CHANNEL)).length === 0
);

/* ------------------------------------------------------------------ */
section("Rate limiting");

await resetMessageBudget(client, USER);
// Sequential on purpose: this asserts the budget counts DOWN, which only
// means anything in order. The concurrent case is the burst test below.
const taken: RateLimitResult[] = [];
for (let i = 0; i < 5; i += 1) {
  taken.push(await takeMessageSlot(client, USER, { limit: 5, windowMs: 1000 }));
}
check(
  "the budget allows exactly the limit",
  taken.every((r) => r.allowed),
  taken.map((r) => r.allowed)
);
check("and counts down to zero", taken.at(-1)?.remaining === 0, taken.at(-1));

const denied = await takeMessageSlot(client, USER, {
  limit: 5,
  windowMs: 1000,
});
check("the next one is refused", denied.allowed === false, denied);
check(
  "with a real retry time, not a fixed backoff",
  denied.retryAfterMs > 0 && denied.retryAfterMs <= 1000,
  denied
);

// The token test. Six concurrent takes land in the same millisecond; written
// under a shared ZSET member they would collapse into one entry and let a fast
// enough client past the limit.
await resetMessageBudget(client, USER);
const burst = await Promise.all(
  Array.from({ length: 6 }, () =>
    takeMessageSlot(client, USER, { limit: 5, windowMs: 1000 })
  )
);
const allowedInBurst = burst.filter((r) => r.allowed).length;
check(
  "a same-millisecond burst cannot exceed the limit",
  allowedInBurst === 5,
  {
    allowedInBurst,
  }
);

await sleep(1100);
const afterWindow = await takeMessageSlot(client, USER, {
  limit: 5,
  windowMs: 1000,
});
check(
  "the window slides and frees the budget",
  afterWindow.allowed,
  afterWindow
);

/* ------------------------------------------------------------------ */
section("Voice");

const size = await joinVoice(client, CHANNEL, USER, {
  peerId: "peer-1",
  selfDeaf: false,
  selfMute: false,
  serverDeaf: false,
  serverMute: false,
});
check("joining reports the roster size", size === 1, size);

const patched = await updateVoiceState(client, CHANNEL, USER, {
  selfMute: true,
});
check(
  "a state patch merges rather than replaces",
  patched?.selfMute === true && typeof patched.joinedAt === "number",
  patched
);

await joinVoice(client, CHANNEL, OTHER, {
  peerId: "peer-2",
  selfDeaf: false,
  selfMute: false,
  serverDeaf: false,
  serverMute: false,
});
check(
  "the roster lists everyone",
  (await getVoiceMembers(client, CHANNEL)).length === 2
);

// OTHER has no presence key, so it is a ghost left behind by a crashed node.
await touchPresence(client, { socketId: "sock-1", userId: USER });
const ghosts = await sweepVoiceChannel(client, CHANNEL);
check(
  "the sweep removes only members with no presence",
  ghosts.length === 1 && ghosts[0] === OTHER,
  ghosts
);

const emptied = await leaveVoice(client, CHANNEL, USER);
check("the last leaver empties the channel", emptied === 0, emptied);
check(
  "and the hash is deleted, not left as an empty key",
  (await client.exists(voiceMembersKey(CHANNEL))) === 0
);

/* ------------------------------------------------------------------ */
section("Pub/sub");

const receivedEvents: { origin: string }[] = [];
const handle = await subscribeEvents(
  subscriber,
  "guild",
  GUILD,
  (incoming) => {
    receivedEvents.push(incoming);
  },
  { origin: "node-self" }
);

await publishEvent(client, "guild", GUILD, {
  memberId: "someone",
  origin: "node-other",
  ts: Date.now(),
  type: "member.joined",
});
await publishEvent(client, "guild", GUILD, {
  memberId: "someone",
  origin: "node-self",
  ts: Date.now(),
  type: "member.joined",
});
await sleep(150);

check(
  "an event from another node arrives",
  receivedEvents.length === 1,
  receivedEvents
);
check(
  "and a node's own event is not echoed back to it",
  receivedEvents.every((e) => e.origin === "node-other")
);

await handle.unsubscribe();

/* ------------------------------------------------------------------ */
await client.del(
  userStatusKey(USER),
  userSocketsKey(USER),
  userSocketKey(USER, "sock-1")
);
await resetMessageBudget(client, USER);
await subscriber.quit();
await client.quit();
await closeKvConnections();

process.stdout.write(
  failed === 0
    ? `\n${GREEN}All ${passed} assertions passed.${RESET}\n`
    : `\n${RED}${failed} failed, ${passed} passed.${RESET}\n`
);
process.exit(failed === 0 ? 0 : 1);
