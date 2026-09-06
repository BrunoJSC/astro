"use client";

import { Button } from "@repo/ui/components";
import { useEffect } from "react";

/**
 * Error boundaries must be Client Components -- Next needs `reset` to run in
 * the browser. This is the file where the Server/Client boundary is explicit,
 * and where Biome's React hook rules apply.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Replace with the app's reporter; `digest` correlates with the server log.
    process.stderr.write(`${error.digest ?? "no-digest"}: ${error.message}\n`);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="space-y-2">
        <h1 className="font-semibold text-2xl">Something went wrong</h1>
        <p className="text-muted-foreground text-sm">
          {error.digest ? `Reference: ${error.digest}` : "An error occurred."}
        </p>
      </div>

      <Button onClick={reset} variant="outline">
        Try again
      </Button>
    </main>
  );
}
