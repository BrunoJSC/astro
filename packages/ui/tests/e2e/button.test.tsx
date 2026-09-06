import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, buttonVariants } from "../../src/components/button";
import { build, emits } from "./tailwind";

/**
 * The Button, rendered.
 *
 * `tests/unit/cn.test.ts` covers the merge helper in isolation. Nothing has
 * ever rendered a component: not Base UI's element choice, not the cva ->
 * tailwind-merge composition, and -- the gap that matters most -- not whether
 * the class names a variant emits are class names Tailwind can compile.
 *
 * `react-dom/server` rather than a DOM library. The markup is all these
 * assertions need, and a jsdom/happy-dom dependency to read an attribute would
 * cost more than it proves.
 */

const VARIANTS = [
  "default",
  "destructive",
  "ghost",
  "link",
  "outline",
  "secondary",
] as const;

const SIZES = ["default", "icon", "lg", "sm"] as const;

/**
 * The `class="..."` value of the first element in a fragment of markup.
 *
 * Entity-decoded, because React escapes the attribute on the way out and the
 * arbitrary variants are full of characters that need it: `[&_svg]:shrink-0`
 * is written `[&amp;_svg]:shrink-0` and `has-[>svg]:px-3` is written
 * `has-[&gt;svg]:px-3`. Comparing those against the source strings without
 * decoding fails for a reason that has nothing to do with the styles.
 */
function classesOf(markup: string): string[] {
  const match = markup.match(/class="([^"]*)"/);
  return (match?.[1] ?? "")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .split(" ")
    .filter(Boolean);
}

describe("rendering", () => {
  it("renders a native button, typed so it cannot submit a form by accident", () => {
    /*
     * Base UI's contract, and worth pinning: an unstyled headless button that
     * quietly rendered a `div` would lose keyboard activation and the implicit
     * role, and nothing in the styles would look different.
     */
    const markup = renderToStaticMarkup(<Button>Send</Button>);

    expect(markup).toStartWith("<button");
    expect(markup).toContain('type="button"');
    expect(markup).toContain("Send");
  });

  it("carries the base classes and the default variant", () => {
    const classes = classesOf(renderToStaticMarkup(<Button>Send</Button>));

    expect(classes).toContain("inline-flex");
    expect(classes).toContain("bg-primary");
    expect(classes).toContain("text-primary-foreground");
    // `defaultVariants` supplies the size without the prop being passed.
    expect(classes).toContain("h-9");
  });

  it("swaps the variant without leaving the previous one behind", () => {
    const classes = classesOf(
      renderToStaticMarkup(<Button variant="destructive">Delete</Button>),
    );

    expect(classes).toContain("bg-destructive");
    expect(classes).not.toContain("bg-primary");
  });

  it("swaps the size the same way", () => {
    const classes = classesOf(
      renderToStaticMarkup(<Button size="icon">+</Button>),
    );

    expect(classes).toContain("size-9");
    expect(classes).not.toContain("h-9");
  });

  it("lets a caller's className win over the variant it collides with", () => {
    /*
     * The reason `cn` wraps cva rather than a plain join. Both classes would
     * otherwise be present and the winner would be whichever Tailwind happened
     * to emit last in the stylesheet -- a rule the caller cannot see.
     */
    const classes = classesOf(
      renderToStaticMarkup(<Button className="bg-secondary">Send</Button>),
    );

    expect(classes).toContain("bg-secondary");
    expect(classes).not.toContain("bg-primary");
  });

  it("keeps a className that collides with nothing", () => {
    const classes = classesOf(
      renderToStaticMarkup(<Button className="w-full">Send</Button>),
    );

    expect(classes).toContain("w-full");
    expect(classes).toContain("bg-primary");
  });

  it("renders as another element through Base UI's render prop", () => {
    // How a link-styled button stays a link: `variant="link"` is only paint,
    // and an anchor is what gives it an href, middle-click and a status bar.
    const markup = renderToStaticMarkup(
      <Button render={<a href="/docs" />} variant="link">
        Docs
      </Button>,
    );

    expect(markup).toStartWith("<a");
    expect(markup).toContain('href="/docs"');
    expect(classesOf(markup)).toContain("underline-offset-4");
  });

  it("passes disabled through to the element", () => {
    const markup = renderToStaticMarkup(<Button disabled>Send</Button>);

    expect(markup).toContain("disabled");
  });
});

describe("every rendered class is one Tailwind can compile", () => {
  /*
   * The assertion that ties the component to the stylesheet, and the only one
   * here that needs the compiler.
   *
   * A typo in a variant string -- `whitespace-norwap`, `bg-primry` -- is
   * invisible to TypeScript, to Biome and to every other test in this package:
   * the class renders, the markup looks right, and the button is simply
   * unstyled in the browser. Compiling the real stylesheet and looking for each
   * rendered class is what turns that into a failure here.
   */
  it("compiles all of them, across every variant and size", async () => {
    const rendered = new Set<string>();
    for (const variant of VARIANTS) {
      for (const size of SIZES) {
        for (const cls of classesOf(
          renderToStaticMarkup(
            <Button size={size} variant={variant}>
              x
            </Button>,
          ),
        )) {
          rendered.add(cls);
        }
      }
    }

    // Passed in as candidates as well as scanned: `@source` covers the classes
    // that appear literally in `button.tsx`, and this covers the composition.
    const css = await build([...rendered]);

    const missing = [...rendered].filter((cls) => !emits(css, cls));
    expect(missing).toEqual([]);
  });

  it("covers a real number of classes, so an empty set cannot pass", () => {
    const classes = new Set(
      VARIANTS.flatMap((variant) =>
        SIZES.flatMap((size) =>
          classesOf(
            renderToStaticMarkup(
              <Button size={size} variant={variant}>
                x
              </Button>,
            ),
          ),
        ),
      ),
    );

    expect(classes.size).toBeGreaterThan(25);
  });

  it("resolves the conflicts cva alone leaves in place", () => {
    /*
     * `buttonVariants` concatenates: for `size="sm"` it emits the base
     * `gap-2` AND the size's `gap-1.5`, and both survive into its return value.
     * The component runs that through `cn`, so only the later one renders.
     *
     * Worth pinning because `buttonVariants` is exported. A consumer styling
     * their own element with it gets the unresolved string, and must wrap it in
     * `cn` themselves -- otherwise which gap applies depends on the order
     * Tailwind happened to emit the two rules in.
     */
    const raw = buttonVariants({ size: "sm", variant: "outline" }).split(" ");
    expect(raw).toContain("gap-2");
    expect(raw).toContain("gap-1.5");

    const rendered = classesOf(
      renderToStaticMarkup(
        <Button size="sm" variant="outline">
          x
        </Button>,
      ),
    );

    expect(rendered).not.toContain("gap-2");
    expect(rendered).toContain("gap-1.5");
    // And `gap-2` is the ONLY thing dropped -- a merge that swallowed anything
    // else would silently change how the button looks.
    expect(raw.filter((cls) => !rendered.includes(cls))).toEqual(["gap-2"]);
    // `rounded-md` appears twice in the raw string (base and size); the set
    // comparison is what makes that a duplicate rather than a second conflict.
    expect(new Set(rendered).size).toBe(new Set(raw).size - 1);
  });
});
