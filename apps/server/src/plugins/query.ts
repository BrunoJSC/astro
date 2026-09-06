import { QueryClient } from "@tanstack/query-core";
import { Elysia } from "elysia";

/**
 * Cache windows shared by the server and every client that talks to it.
 *
 * `staleTime` is how long a cached entry is served without refetching;
 * `gcTime` is how long an unused entry survives before collection, and must
 * stay above `staleTime` or entries are evicted while still fresh.
 */
export const QUERY_DEFAULTS = {
  gcTime: 5 * 60 * 1000, // 5 minutes
  staleTime: 30 * 1000, // 30 seconds
} as const;

/**
 * A fresh QueryClient.
 *
 * Never hoist this into a module-level singleton on the server: a shared cache
 * is a cache shared across users, so one request's prefetched data would be
 * handed to the next. Browsers are the opposite case -- one client for the
 * lifetime of the app, which is what `apps/web`'s Providers does.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: QUERY_DEFAULTS.gcTime,
        refetchOnWindowFocus: false,
        retry: 1,
        staleTime: QUERY_DEFAULTS.staleTime,
      },
    },
  });
}

/**
 * Puts a per-request `queryClient` on the context, for handlers that prefetch
 * or hydrate on the server. One instance per request, for the reason above.
 */
export const queryPlugin = new Elysia({ name: "plugin.query" }).derive(
  { as: "scoped" },
  () => ({ queryClient: createQueryClient() })
);
