import type { EventMap, EventScope } from "@repo/kv";
import { type SubscriptionHandle, subscribeEvents } from "@repo/kv";
import type { Redis } from "ioredis";

/**
 * Which sockets on THIS node care about which pub/sub channel.
 *
 * The problem it solves is refcounting. A node holding two members of the same
 * guild must subscribe to `events:guild:{g}` exactly once: `SUBSCRIBE` twice on
 * one connection is idempotent at the Redis level, but each call adds another
 * `message` listener, so every event would be handled -- and delivered -- as
 * many times as there are interested sockets. The duplicate is invisible in
 * development with one user and obvious in production with two.
 *
 * So one Redis subscription per topic, a local set of sockets behind it, and
 * the subscription is torn down when the last of them leaves. The fan-out is
 * O(sockets on this node), which is a loop over an in-memory Set rather than
 * anything crossing the network.
 */

export type Topic = `${EventScope}:${string}`;

export interface GatewaySocket {
  readonly id: string;
  send: (payload: string) => unknown;
  readonly userId: string;
}

interface Subscription {
  handle: SubscriptionHandle;
  sockets: Set<GatewaySocket>;
}

export interface RegistryOptions {
  onError?: (error: unknown) => void;
  /**
   * This node's identity, passed to every publish and every subscribe.
   *
   * A node subscribes to the channels it also publishes on, so without it the
   * node re-delivers its own events to sockets that were already updated
   * locally -- one duplicate per event, for every client attached to whichever
   * node happened to handle the request.
   */
  origin: string;
}

export class GatewayRegistry {
  private readonly subscriptions = new Map<Topic, Subscription>();
  /** Every live socket for a user on this node, across their devices. */
  private readonly byUser = new Map<string, Set<GatewaySocket>>();
  /** Reverse index, so `remove` does not walk every topic. */
  private readonly topicsBySocket = new Map<string, Set<Topic>>();
  /**
   * Joins in flight, keyed by topic.
   *
   * Two sockets joining the same topic in the same tick would both see no
   * subscription and both create one. Awaiting the first attempt makes the
   * second reuse it.
   */
  private readonly pending = new Map<Topic, Promise<Subscription>>();

  private readonly subscriber: Redis;
  private readonly options: RegistryOptions;

  constructor(subscriber: Redis, options: RegistryOptions) {
    this.subscriber = subscriber;
    this.options = options;
  }

  /** Registers a socket and subscribes it to its own private channel. */
  async add(socket: GatewaySocket): Promise<void> {
    const forUser = this.byUser.get(socket.userId) ?? new Set();
    forUser.add(socket);
    this.byUser.set(socket.userId, forUser);
    this.topicsBySocket.set(socket.id, new Set());

    await this.join(socket, "user", socket.userId);
  }

  /** Unregisters a socket and drops every subscription it was the last holder of. */
  async remove(socket: GatewaySocket): Promise<void> {
    const topics = this.topicsBySocket.get(socket.id) ?? new Set();
    // Copied before iterating: `leave` mutates the same set.
    await Promise.all(
      [...topics].map((topic) => this.leaveTopic(socket, topic))
    );
    this.topicsBySocket.delete(socket.id);

    const forUser = this.byUser.get(socket.userId);
    forUser?.delete(socket);
    if (forUser && forUser.size === 0) {
      this.byUser.delete(socket.userId);
    }
  }

  async join(
    socket: GatewaySocket,
    scope: EventScope,
    id: string
  ): Promise<void> {
    const topic = `${scope}:${id}` as Topic;
    const subscription = await this.ensure(topic, scope, id);

    subscription.sockets.add(socket);
    this.topicsBySocket.get(socket.id)?.add(topic);
  }

  async leave(
    socket: GatewaySocket,
    scope: EventScope,
    id: string
  ): Promise<void> {
    await this.leaveTopic(socket, `${scope}:${id}` as Topic);
  }

  /** Live sockets for a user on this node. Empty when they are elsewhere. */
  socketsFor(userId: string): readonly GatewaySocket[] {
    return [...(this.byUser.get(userId) ?? [])];
  }

  get topicCount(): number {
    return this.subscriptions.size;
  }

  /** Drops every subscription. For shutdown, so Redis is not left holding them. */
  async close(): Promise<void> {
    await Promise.all(
      [...this.subscriptions.values()].map((sub) => sub.handle.unsubscribe())
    );
    this.subscriptions.clear();
    this.topicsBySocket.clear();
    this.byUser.clear();
  }

  private ensure(
    topic: Topic,
    scope: EventScope,
    id: string
  ): Promise<Subscription> {
    const existing = this.subscriptions.get(topic);
    if (existing) {
      return Promise.resolve(existing);
    }

    const inFlight = this.pending.get(topic);
    if (inFlight) {
      return inFlight;
    }

    const created = subscribeEvents(
      this.subscriber,
      scope,
      id,
      (event) => {
        this.deliver(topic, scope, event);
      },
      { onError: this.options.onError, origin: this.options.origin }
    )
      .then((handle) => {
        const subscription: Subscription = { handle, sockets: new Set() };
        this.subscriptions.set(topic, subscription);
        return subscription;
      })
      .finally(() => {
        this.pending.delete(topic);
      });

    this.pending.set(topic, created);
    return created;
  }

  private deliver(
    topic: Topic,
    scope: EventScope,
    event: EventMap[EventScope]
  ): void {
    const subscription = this.subscriptions.get(topic);
    if (!subscription) {
      return;
    }

    // Serialised once for the whole fan-out rather than per socket: a busy
    // guild event reaches hundreds of sockets on one node, and JSON.stringify
    // is the expensive part of that loop.
    const payload = JSON.stringify({ event, op: "event", scope, topic });

    for (const socket of subscription.sockets) {
      try {
        socket.send(payload);
      } catch (error) {
        // A socket that died between the event arriving and this write must
        // not stop delivery to the rest. Its close handler does the cleanup.
        this.options.onError?.(error);
      }
    }
  }

  private async leaveTopic(socket: GatewaySocket, topic: Topic): Promise<void> {
    const subscription = this.subscriptions.get(topic);
    this.topicsBySocket.get(socket.id)?.delete(topic);

    if (!subscription) {
      return;
    }

    subscription.sockets.delete(socket);

    if (subscription.sockets.size === 0) {
      this.subscriptions.delete(topic);
      await subscription.handle.unsubscribe();
    }
  }
}
