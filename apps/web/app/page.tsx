import { Button } from "@repo/ui/components";
import { cn } from "@repo/ui/lib";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-8 px-6">
      <div className="space-y-3">
        <h1 className="font-semibold text-3xl tracking-tight">Astro</h1>
        <p className="text-muted-foreground">
          Design system, environment and API contracts shared across web, native
          and desktop.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost" size="sm">
          Ghost
        </Button>
        <Button variant="destructive">Destructive</Button>
      </div>

      {/* `cn` resolves the conflict: the caller's h-12 wins over the variant's h-9. */}
      <Button className={cn("h-12 w-full")} variant="outline">
        Full width, overridden height
      </Button>
    </main>
  );
}
