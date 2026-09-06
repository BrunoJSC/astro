import { treaty } from "@elysiajs/eden";
import { describe, expect, expectTypeOf, it } from "vitest";
import { unwrap } from "../../src/eden";
import { app } from "../../src/index";
import type { App } from "../../src/type";

// Treaty accepts the Elysia instance directly, so these calls exercise the
// real module tree in-process -- no socket, no base URL.
const client = treaty<App>(app);

describe("eden treaty", () => {
  it("calls the health module through the typed client", async () => {
    const { data, error, status } = await client.health.get();
    expect(error).toBeNull();
    expect(status).toBe(200);
    expect(data).toEqual({ status: "ok" });
  });

  it("infers the response type from the module's TypeBox model", async () => {
    const { data } = await client.health.get();
    // Compile-time assertion: a drifted model fails `check-types`, not just
    // this test at runtime.
    expectTypeOf(data).toEqualTypeOf<{ status: "ok" } | null>();
  });

  it("types the 401 branch of v1/me as a discriminated result", async () => {
    const { data, error } = await client.v1.me.get();
    expect(data).toBeNull();
    expect(error?.status).toBe(401);
    expect(error?.value).toEqual({ message: "Not authenticated" });
  });

  it("unwrap() turns the error envelope into a rejection", async () => {
    await expect(unwrap(client.v1.me.get())).rejects.toThrow(
      "Request failed with status 401"
    );
  });

  it("unwrap() returns the payload on success", async () => {
    await expect(unwrap(client.health.get())).resolves.toEqual({
      status: "ok",
    });
  });
});
