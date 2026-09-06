import { Elysia } from "elysia";
import { describe, expect, it } from "vitest";
import { healthModule } from "../../src/modules/health";
import { v1Module } from "../../src/modules/v1";

/**
 * Each module is an isolated Elysia instance, so it can be mounted on its own
 * without CORS, docs or its siblings. That isolation is the point of the
 * plugin architecture -- these tests would be impossible with routes defined
 * inline on the root app.
 */
describe("module isolation", () => {
  it("mounts the health module standalone", async () => {
    const solo = new Elysia().use(healthModule);
    const res = await solo.handle(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
  });

  it("mounts the v1 module standalone, with its auth plugin", async () => {
    const solo = new Elysia().use(v1Module);
    const res = await solo.handle(new Request("http://localhost/v1/me"));
    expect(res.status).toBe(401);
  });

  it("deduplicates a plugin mounted twice by name", async () => {
    // Elysia keys plugins on `name`; mounting v1 twice must not register the
    // auth derive twice nor conflict on the route.
    const twice = new Elysia().use(v1Module).use(v1Module);
    const res = await twice.handle(new Request("http://localhost/v1/me"));
    expect(res.status).toBe(401);
  });
});
