import { t } from "elysia";

/**
 * The wire format, in both directions.
 *
 * Validation is asymmetric on purpose.
 *
 * Inbound frames are validated strictly. They are the only untrusted input the
 * gateway takes, and every one of them either causes a write to Redis or a
 * publish that fans out to other nodes -- so a malformed `channelId` is not a
 * client bug, it is a way to write junk into someone else's channel index.
 * Elysia rejects anything that does not match before a handler sees it.
 *
 * Outbound frames are declared permissively. The event payloads are already
 * typed at the publish site by the discriminated unions in `@repo/kv`, and
 * re-describing those unions in TypeBox would duplicate them -- which means
 * they would drift, and the drift would show up as messages the server refuses
 * to send to its own clients. The strict types live in one place; this schema
 * describes the envelope around them.
 */

/** Frames the client may send. */
export const clientFrame = t.Union([
  t.Object({ op: t.Literal("ping") }),

  t.Object({
    customStatus: t.Optional(t.Union([t.String({ maxLength: 128 }), t.Null()])),
    op: t.Literal("presence.update"),
    state: t.Union([
      t.Literal("online"),
      t.Literal("idle"),
      t.Literal("dnd"),
      t.Literal("offline"),
    ]),
  }),

  /*
   * Subscribing is a request, not a command. The scope and id are checked
   * against the user's memberships before anything is joined -- a client that
   * could subscribe to an arbitrary guild would receive every message in it.
   */
  t.Object({
    id: t.String({ format: "uuid" }),
    op: t.Literal("subscribe"),
    scope: t.Union([t.Literal("guild"), t.Literal("channel")]),
  }),
  t.Object({
    id: t.String({ format: "uuid" }),
    op: t.Literal("unsubscribe"),
    scope: t.Union([t.Literal("guild"), t.Literal("channel")]),
  }),

  t.Object({
    channelId: t.String({ format: "uuid" }),
    op: t.Literal("typing.start"),
  }),
  t.Object({
    channelId: t.String({ format: "uuid" }),
    op: t.Literal("typing.stop"),
  }),

  t.Object({
    channelId: t.String({ format: "uuid" }),
    op: t.Literal("voice.join"),
    peerId: t.String({ maxLength: 128 }),
    selfDeaf: t.Optional(t.Boolean()),
    selfMute: t.Optional(t.Boolean()),
  }),
  t.Object({
    channelId: t.String({ format: "uuid" }),
    op: t.Literal("voice.update"),
    selfDeaf: t.Optional(t.Boolean()),
    selfMute: t.Optional(t.Boolean()),
  }),
  t.Object({
    channelId: t.String({ format: "uuid" }),
    op: t.Literal("voice.leave"),
  }),
]);

export type ClientFrame = typeof clientFrame.static;

/**
 * Frames the server sends.
 *
 * `t.Unknown()` on the payloads is the deliberate half described above. The
 * envelope -- `op`, and the routing fields the client dispatches on -- is
 * described precisely, because that is what a consumer switches over.
 */
export const serverFrame = t.Union([
  t.Object({
    /** How often the client should send `ping`, in milliseconds. */
    heartbeatIntervalMs: t.Number(),
    op: t.Literal("ready"),
    socketId: t.String(),
    userId: t.String(),
  }),
  t.Object({ op: t.Literal("pong") }),
  t.Object({
    code: t.String(),
    message: t.String(),
    op: t.Literal("error"),
    /** Present on `rate_limited`, so a client can back off by the real amount. */
    retryAfterMs: t.Optional(t.Number()),
  }),
  t.Object({
    id: t.String(),
    op: t.Literal("subscribed"),
    scope: t.String(),
  }),
  t.Object({
    channelId: t.String(),
    op: t.Literal("typing"),
    users: t.Array(t.Object({ expiresAt: t.Number(), userId: t.String() })),
  }),
  t.Object({
    channelId: t.String(),
    members: t.Array(t.Unknown()),
    op: t.Literal("voice.roster"),
  }),
  /** Anything that arrived over pub/sub from another node. */
  t.Object({
    event: t.Unknown(),
    op: t.Literal("event"),
    scope: t.String(),
    topic: t.String(),
  }),
]);

export type ServerFrame = typeof serverFrame.static;

export const gatewayModel = { clientFrame, serverFrame } as const;
