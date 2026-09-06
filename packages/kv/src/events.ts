import type { Redis } from "ioredis";
import type { KvClient } from "./client";
import {
  channelEventChannel,
  guildEventChannel,
  userEventChannel,
} from "./keys";
import type { EventMap, EventScope } from "./types";

/**
 * Fan-out between WebSocket nodes.
 *
 * A socket is held by exactly one node, so a message written on node A has to
 * reach the sockets on nodes B and C. Redis pub/sub is the bus, and the shape
 * of the problem is what the types here encode: the scope of a channel decides
 * who receives the payload, so a private notification must not be
 * constructible on a guild channel.
 *
 * ## What this is not
 *
 * Pub/sub is fire-and-forget. A node that is disconnected when an event is
 * published does not receive it on reconnect -- there is no backlog, no offset,
 * no acknowledgement. That is the right trade for presence and typing, which
 * are worthless a second late, and the wrong one for message delivery.
 *
 * Messages survive because they are written to ScyllaDB before being published,
 * so a client that missed the event still gets the message on its next read.
 * The event is an invalidation hint, never the only copy.
 */

const BUILDERS: Record<EventScope, (id: string) => string> = {
  channel: channelEventChannel,
  guild: guildEventChannel,
  user: userEventChannel,
};

/**
 * Publish to one scope.
 *
 * Returns how many subscribers received it, which is Redis telling you the
 * truth about your cluster: a persistent zero for a busy guild means the
 * receiving nodes are not subscribed, not that the guild is quiet.
 */
export async function publishEvent<S extends EventScope>(
  client: KvClient,
  scope: S,
  id: string,
  event: EventMap[S]
): Promise<number> {
  return await client.publish(BUILDERS[scope](id), JSON.stringify(event));
}

export interface SubscriptionHandle {
  unsubscribe: () => Promise<void>;
}

export interface SubscribeOptions {
  /**
   * This node's identifier. Events carrying this `origin` are dropped.
   *
   * A node subscribes to the same channels it publishes on, so without this it
   * receives its own events and delivers them a second time to sockets that
   * were already updated locally -- a duplicate message in every client
   * attached to the publishing node.
   */
  origin?: string;
}

/**
 * Subscribe to one scope's channel.
 *
 * The subscriber connection is separate from the command connection, and it has
 * to be: a subscribed connection refuses every command except subscribe,
 * unsubscribe and ping. `createKvSubscriber` produces the right one.
 *
 * Handlers run on Redis's message callback, so one that throws would take down
 * the shared listener for every subscription on this connection. They are
 * isolated here instead, and a failure is reported through `onError`.
 */
export function subscribeEvents<S extends EventScope>(
  subscriber: Redis,
  scope: S,
  id: string,
  handler: (event: EventMap[S]) => void | Promise<void>,
  options: SubscribeOptions & { onError?: (error: unknown) => void } = {}
): Promise<SubscriptionHandle> {
  const channel = BUILDERS[scope](id);

  const listener = (incoming: string, payload: string) => {
    if (incoming !== channel) {
      return;
    }

    let event: EventMap[S];
    try {
      event = JSON.parse(payload) as EventMap[S];
    } catch (error) {
      options.onError?.(error);
      return;
    }

    if (
      options.origin &&
      (event as { origin?: string }).origin === options.origin
    ) {
      return;
    }

    try {
      const result = handler(event);
      if (result instanceof Promise) {
        result.catch((error) => options.onError?.(error));
      }
    } catch (error) {
      options.onError?.(error);
    }
  };

  subscriber.on("message", listener);

  return subscriber.subscribe(channel).then(() => ({
    async unsubscribe() {
      subscriber.off("message", listener);
      await subscriber.unsubscribe(channel);
    },
  }));
}
