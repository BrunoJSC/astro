"use client";

import { createQueryClient } from "@repo/server/plugins/query";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";

/**
 * Client-side providers for the whole tree.
 *
 * Mounted once in `app/layout.tsx`. Everything below this line runs in the
 * browser, which is why the layout itself stays a Server Component: only this
 * subtree is shipped, not the pages that render inside it.
 */
export function Providers({ children }: { children: ReactNode }) {
  /*
   * `useState` with a factory, not a module-level constant and not `useMemo`.
   *
   * A module-level client would be created once per server process and shared
   * across every user's request -- one visitor's cached data served to the
   * next. `useMemo` is not a guarantee: React may discard and recompute it,
   * dropping the cache mid-session. `useState`'s initializer runs exactly once
   * per mounted component, which is the lifetime a query cache should have.
   *
   * The cache windows come from `@repo/server/plugins/query`, so the API's own notion
   * of staleness and the browser's stay the same value.
   */
  const [queryClient] = useState(() => createQueryClient());

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
