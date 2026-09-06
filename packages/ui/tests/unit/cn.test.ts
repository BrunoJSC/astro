import { describe, expect, it } from "bun:test";
import { buttonVariants } from "../../src/components/button";
import { cn } from "../../src/lib/cn";

describe("cn", () => {
  it("joins conditional classes", () => {
    expect(cn("a", false, "c")).toBe("a c");
  });

  it("lets the last conflicting Tailwind class win", () => {
    // The whole reason twMerge sits behind clsx: without it both would be
    // emitted and CSS source order -- not the caller -- would decide.
    expect(cn("px-4", "px-8")).toBe("px-8");
    expect(cn("bg-primary", "bg-destructive")).toBe("bg-destructive");
  });

  it("keeps non-conflicting utilities", () => {
    expect(cn("px-4", "py-2")).toBe("px-4 py-2");
  });
});

describe("buttonVariants", () => {
  it("applies the default variant and size", () => {
    const classes = buttonVariants();
    expect(classes).toContain("bg-primary");
    expect(classes).toContain("h-9");
  });

  it("switches variant and size", () => {
    const classes = buttonVariants({ size: "sm", variant: "outline" });
    expect(classes).toContain("border");
    expect(classes).toContain("h-8");
    expect(classes).not.toContain("bg-primary");
  });

  it("lets className override a variant class", () => {
    expect(buttonVariants({ className: "h-20" })).toContain("h-20");
  });
});
