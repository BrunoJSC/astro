import { describe, expect, it } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as ui from "../../src/components";
import { build, emits } from "./tailwind";

/**
 * Every component in the package, rendered once and checked against the CSS.
 *
 * `button.test.tsx` is the full treatment for one component -- variants,
 * states, the `render` prop, the merge behaviour. This file is the other axis:
 * shallow, and covering all of them.
 *
 * The assertion that earns its place is the second one. A typo in a class
 * string -- `bg-primry`, `whitespace-norwap` -- passes TypeScript, passes
 * Biome, renders without complaint, and leaves the component unstyled. Looking
 * every rendered class up in the compiled stylesheet is what turns that into a
 * failure, and it is the only check here that could not be written by reading
 * the source.
 *
 * The components come from the shadcn registry and `shadcn add` regenerates
 * them, so this suite is also what catches a registry update quietly shipping
 * a class the theme does not resolve.
 */

/**
 * One rendering per component, with the minimum props each needs.
 *
 * Compound components are rendered through their root, since that is the only
 * arrangement their parts are valid in -- a `DialogContent` outside a
 * `Dialog` throws rather than producing markup.
 */
const CASES: [string, ReactElement][] = [
  ["Avatar", <ui.Avatar key="a" />],
  ["Button", <ui.Button key="b">Send</ui.Button>],
  ["Checkbox", <ui.Checkbox key="c" />],
  ["Input", <ui.Input key="i" />],
  ["Label", <ui.Label key="l">Name</ui.Label>],
  ["Separator", <ui.Separator key="s" />],
  ["Textarea", <ui.Textarea key="t" />],
  [
    "Card",
    <ui.Card key="card">
      <ui.CardHeader>
        <ui.CardTitle>Title</ui.CardTitle>
        <ui.CardDescription>Description</ui.CardDescription>
      </ui.CardHeader>
      <ui.CardContent>Body</ui.CardContent>
      <ui.CardFooter>Footer</ui.CardFooter>
    </ui.Card>,
  ],
  [
    "Field",
    <ui.FieldSet key="field">
      <ui.Field>
        <ui.FieldLabel>Name</ui.FieldLabel>
        <ui.FieldContent>
          <ui.Input />
        </ui.FieldContent>
        <ui.FieldDescription>Your display name.</ui.FieldDescription>
      </ui.Field>
    </ui.FieldSet>,
  ],
  [
    "InputGroup",
    <ui.InputGroup key="ig">
      <ui.InputGroupInput />
      <ui.InputGroupAddon>
        <ui.InputGroupText>@</ui.InputGroupText>
      </ui.InputGroupAddon>
    </ui.InputGroup>,
  ],
  [
    "Bubble",
    <ui.BubbleGroup key="bubble">
      <ui.Bubble>
        <ui.BubbleContent>Hello</ui.BubbleContent>
      </ui.Bubble>
    </ui.BubbleGroup>,
  ],
  [
    "Message",
    <ui.MessageGroup key="msg">
      <ui.Message>
        <ui.MessageHeader>Ana</ui.MessageHeader>
        <ui.MessageContent>Hello</ui.MessageContent>
      </ui.Message>
    </ui.MessageGroup>,
  ],
  [
    "Attachment",
    <ui.AttachmentGroup key="att">
      <ui.Attachment>
        <ui.AttachmentContent>
          <ui.AttachmentTitle>file.png</ui.AttachmentTitle>
        </ui.AttachmentContent>
      </ui.Attachment>
    </ui.AttachmentGroup>,
  ],
];

/**
 * Class names that correctly produce no CSS rule, with the reason for each.
 *
 * Without this list the check below is unusable -- it reported six "failures"
 * on its first run, and none of them was a defect.
 */
const NO_RULE_EXPECTED = [
  /*
   * Tailwind's named group and peer MARKERS. `group/card-header` is not a
   * utility; it names a group so a descendant can write
   * `group-data-[x]/card-header:`. Tailwind emits nothing for the marker
   * itself, by design.
   */
  /^(group|peer)\//,
  /*
   * Utilities that live in `shadcn/tailwind.css`, which this package
   * deliberately does not import. `@repo/ui/styles` is hand-written -- an
   * oklch palette with twelve tests pinning it -- and pulling in an upstream
   * layer over it is a decision, not a detail.
   *
   * The cost is real and bounded: `attachment` loses its shimmer while a file
   * is uploading or processing, and `message-scroller` loses its edge fade.
   * Both are non-default states of two components. Listed here so the gap is
   * visible rather than absorbed.
   */
  /(^|:)shimmer$/,
  /^scroll-fade(-x)?$/,
];

function expectedToProduceNoRule(className: string): boolean {
  return NO_RULE_EXPECTED.some((pattern) => pattern.test(className));
}

/** The `class="..."` value of every element in a fragment, entity-decoded. */
function classesIn(markup: string): string[] {
  return [...markup.matchAll(/class="([^"]*)"/g)]
    .flatMap((match) =>
      (match[1] ?? "")
        .replace(/&gt;/g, ">")
        .replace(/&lt;/g, "<")
        .replace(/&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .split(" "),
    )
    .filter(Boolean);
}

describe("every component renders", () => {
  it("covers the ones this suite knows about", () => {
    // Without this the loop below can pass on an empty list, which is what a
    // renamed export would produce.
    expect(CASES.length).toBeGreaterThanOrEqual(8);
  });

  it.each(CASES)("%s produces markup", (_name, element) => {
    const markup = renderToStaticMarkup(element);

    expect(markup.length).toBeGreaterThan(0);
    expect(markup).toStartWith("<");
  });
});

describe("every class they render is one Tailwind can compile", () => {
  it("compiles all of them, from one stylesheet", async () => {
    /*
     * All components in one compile rather than one each: the stylesheet is
     * the same for every one of them, and a per-component build would multiply
     * a ~200ms PostCSS run by the size of the list.
     */
    const rendered = new Set<string>();
    for (const [, element] of CASES) {
      for (const cls of classesIn(renderToStaticMarkup(element))) {
        rendered.add(cls);
      }
    }

    expect(rendered.size).toBeGreaterThan(20);

    const css = await build([...rendered]);
    const missing = [...rendered].filter(
      (cls) => !(emits(css, cls) || expectedToProduceNoRule(cls)),
    );

    expect(missing).toEqual([]);
  });
});
