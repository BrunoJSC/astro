import { Button } from "@repo/ui/components";
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 px-6 text-center">
      <div className="space-y-2">
        <h1 className="font-semibold text-2xl">Page not found</h1>
        <p className="text-muted-foreground text-sm">
          The page you are looking for does not exist or has moved.
        </p>
      </div>

      {/* Base UI's `render` prop swaps the element while keeping the button
          semantics and styling -- the shadcn `asChild` equivalent. */}
      <Button render={<Link href="/" />} variant="outline">
        Back home
      </Button>
    </main>
  );
}
