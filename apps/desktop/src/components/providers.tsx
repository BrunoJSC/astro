import { createQueryClient } from "@repo/server/plugins/query";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";

/**
 * Client-side providers for the whole tree.
 *
 * `useState` with a factory rather than a module-level constant: the
 * initializer runs exactly once per mount, which is the lifetime a query cache
 * should have. The reasoning matters less here than on the web -- a desktop
 * process serves one user -- but keeping the three apps identical means a bug
 * found in one is a bug found in all of them.
 *
 * The cache windows come from `@repo/server/plugins/query`, so the API's own
 * notion of staleness and the client's stay the same value.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => createQueryClient());

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
