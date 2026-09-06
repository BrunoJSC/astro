import { treaty } from "@elysiajs/eden";
import type { App } from "./type";

export type EdenClient = ReturnType<typeof treaty<App>>;

/**
 * Builds a typed client against the server's `App` type.
 *
 * Every app calls this with its own base URL: the browser gets a same-origin
 * one, native and desktop an absolute URL, and server-side prefetching passes
 * the incoming request's cookies through `headers`.
 */
export function createEdenClient(
  domain: string,
  headers?: Record<string, string>
): EdenClient {
  return treaty<App>(domain, {
    fetch: { credentials: "include" },
    headers,
  });
}

export class EdenRequestError extends Error {
  readonly status: number;
  readonly value: unknown;

  constructor(status: number, value: unknown) {
    super(`Request failed with status ${status}`);
    this.name = "EdenRequestError";
    this.status = status;
    this.value = value;
  }
}

/**
 * Eden resolves to `{ data, error }` instead of throwing, which is what makes
 * error statuses type-safe. TanStack Query wants the opposite -- a promise
 * that rejects -- so this adapts one to the other at the boundary.
 */
export async function unwrap<T>(
  promise: Promise<{
    data: T | null;
    error: { status: number; value: unknown } | null;
  }>
): Promise<T> {
  const { data, error } = await promise;

  if (error) {
    throw new EdenRequestError(error.status, error.value);
  }

  // `data` is only null when `error` is set, which the branch above returned.
  return data as T;
}

/**
 * Bridges an Eden call into TanStack Query's option shape, so one contract
 * drives both the fetch and the cache key.
 */
export function edenQuery<T>(
  queryKey: readonly unknown[],
  call: () => Promise<{
    data: T | null;
    error: { status: number; value: unknown } | null;
  }>
) {
  return {
    queryFn: () => unwrap(call()),
    queryKey,
  };
}
