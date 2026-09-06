import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildEnv, buildOnce, freePort, WEB } from "./helpers";

/**
 * The built app, served over HTTP.
 *
 * `bundle.test.ts` reads the files the build produced; this asks the server
 * for them. The difference is routing and status codes -- a 404 that renders
 * the right markup with a 200 attached is a broken 404, and reading the
 * prerendered HTML off disk cannot tell the two apart.
 */

let base = "";
let server: ReturnType<typeof Bun.spawn> | undefined;

beforeAll(async () => {
  await buildOnce();

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = Bun.spawn(["bun", "run", "start"], {
    cwd: WEB,
    env: buildEnv({ PORT: String(port) }),
    stderr: "pipe",
    stdout: "pipe",
  });

  await waitForReady();
}, 300_000);

afterAll(() => {
  server?.kill();
});

/**
 * Polls until the server answers.
 *
 * `next start` prints "Ready" before it is, on occasion, and a fixed sleep is
 * either flaky or slower than it needs to be. A request that connects is the
 * only signal that means anything.
 */
async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await fetch(base, { signal: AbortSignal.timeout(2000) });
      return;
    } catch {
      await Bun.sleep(200);
    }
  }

  throw new Error(`next start never answered on ${base}`);
}

describe("serving the built app", () => {
  it("answers the home page with HTML", async () => {
    const response = await fetch(base);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Astro");
  });

  it("sets the document language, which nothing else checks", async () => {
    // `<html lang="en">` in `app/layout.tsx`. A missing lang is invisible in
    // every screenshot and immediately audible in a screen reader.
    expect(await (await fetch(base)).text()).toContain('lang="en"');
  });

  it("answers an unknown route with a real 404", async () => {
    /*
     * The status, not just the markup. Next serves `not-found.tsx` for
     * anything unmatched, and a 200 alongside it would make every typo look
     * like a valid page to a crawler, a monitor and a cache.
     */
    const response = await fetch(`${base}/does-not-exist`);

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Page not found");
  });

  it("serves the stylesheet the document links to", async () => {
    /*
     * The link is followed rather than assumed. A stylesheet emitted with one
     * hash and referenced by another is a page that renders unstyled while
     * every build artefact on disk looks correct.
     */
    const html = await (await fetch(base)).text();
    const href = html.match(/\/_next\/static\/[^"]+\.css/)?.[0];
    expect(href).toBeTruthy();

    const css = await fetch(`${base}${href}`);

    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain("--primary");
  });

  it("serves the client JavaScript the document preloads", async () => {
    const html = await (await fetch(base)).text();
    const src = html.match(/\/_next\/static\/[^"]+\.js/)?.[0];
    expect(src).toBeTruthy();

    expect((await fetch(`${base}${src}`)).status).toBe(200);
  });
});
