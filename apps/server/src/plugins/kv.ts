import { randomUUID } from "node:crypto";
import { env } from "@repo/env/server";
import { closeKvConnections, getKvConnections, type KvClient } from "@repo/kv";
import { Elysia } from "elysia";
import type { Redis } from "ioredis";
import { GatewayRegistry } from "../modules/gateway/registry";

/**
 * Redis/Valkey connections and the local socket registry, as one lazy unit.
 *
 * ## The node id
 *
 * Generated once per process and attached to every event this node publishes.
 * It is what stops a node from re-delivering its own events: a node subscribes
 * to the same channels it publishes on, so without the filter every client
 * attached to the publishing node receives each event twice -- once locally,
 * once back through Redis.
 *
 * Random rather than derived from a hostname, because two processes on one host
 * (a rolling deploy, `bun --watch` restarting) must not share it. During a
 * rollout the old and new processes are both subscribed, and if they shared an
 * origin each would silently drop the other's events.
 */
export const NODE_ID = randomUUID();

export interface Realtime {
  commands: KvClient;
  nodeId: string;
  registry: GatewayRegistry;
  subscriber: Redis;
}

let realtime: Promise<Realtime> | undefined;

/**
 * Connects on first use, never at import.
 *
 * Importing this module must not open sockets: `bun test`, `tsc` and every
 * build step that touches the server's barrel would otherwise try to reach
 * Redis, and the health endpoint would depend on it for no reason.
 *
 * The promise itself is cached, not its result -- two requests arriving before
 * the first connection settles must await the same attempt rather than opening
 * a second pair of connections.
 */
export function getRealtime(): Promise<Realtime> {
  realtime ??= getKvConnections({ url: env.REDIS_URL }).then(
    ({ commands, subscriber }) => ({
      commands,
      nodeId: NODE_ID,
      registry: new GatewayRegistry(subscriber, {
        onError: (error) => {
          process.stderr.write(`[gateway] ${describe(error)}\n`);
        },
        origin: NODE_ID,
      }),
      subscriber,
    })
  );

  return realtime;
}

/**
 * Closes everything, in the order that matters.
 *
 * The registry first: unsubscribing after the connection is gone throws, and
 * leaving subscriptions behind keeps Redis holding them until it notices the
 * socket died.
 */
export async function closeRealtime(): Promise<void> {
  const current = realtime;
  realtime = undefined;

  if (!current) {
    return;
  }

  const { registry } = await current;
  await registry.close();
  await closeKvConnections();
}

/**
 * Puts `realtime()` on the handler context.
 *
 * A function rather than the resolved value: `decorate` is synchronous, and
 * resolving here would make importing the plugin an implicit connection.
 */
export const kvPlugin = new Elysia({ name: "plugin.kv" }).decorate(
  "realtime",
  getRealtime
);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
