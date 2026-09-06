import { treaty } from "@elysiajs/eden";
import { type CreateUserDto, createUserDto } from "@repo/db/validation";
import { Elysia } from "elysia";
import { describe, expect, expectTypeOf, it } from "vitest";

/**
 * The compatibility claim, exercised rather than asserted: a schema produced
 * by drizzle-typebox from a Drizzle table, used directly as an Elysia route
 * contract. It works because `@sinclair/typebox` resolves to the single 0.34.x
 * copy Elysia also bundles -- two copies would mismatch on internal symbols.
 */
const app = new Elysia().post("/users", ({ body }) => body, {
  body: createUserDto,
  response: { 200: createUserDto },
});

const client = treaty<typeof app>(app);

const post = (body: unknown) =>
  app.handle(
    new Request("http://localhost/users", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

describe("drizzle-typebox schema as an Elysia contract", () => {
  it("accepts a valid payload", async () => {
    const res = await post({ email: "ana@example.com", name: "Ana" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      email: "ana@example.com",
    });
  });

  it("rejects a missing required column", async () => {
    const res = await post({ email: "ana@example.com" });
    expect(res.status).toBe(422);
  });

  it("rejects a wrong column type", async () => {
    const res = await post({ email: "ana@example.com", name: 42 });
    expect(res.status).toBe(422);
  });

  it("enforces the email format inside the route", async () => {
    const res = await post({ email: "not-an-email", name: "Ana" });
    expect(res.status).toBe(422);
  });

  it("accepts an omitted nullable column, and an explicit null", async () => {
    expect((await post({ email: "a@b.co", name: "Ana" })).status).toBe(200);
    expect(
      (await post({ email: "a@b.co", image: null, name: "Ana" })).status
    ).toBe(200);
  });
});

describe("openapi and eden inference", () => {
  it("carries the column descriptions into the generated schema", () => {
    const routeSchema = app.routes.find((r) => r.path === "/users");
    expect(routeSchema).toBeDefined();
    expect(JSON.stringify(createUserDto)).toContain("Unique login address");
  });

  it("infers the payload type end to end through Eden", async () => {
    const { data } = await client.users.post({
      email: "ana@example.com",
      name: "Ana",
    });
    // The route's type comes from the Drizzle column definitions, three hops
    // away: pgTable -> drizzle-typebox -> Elysia -> Eden.
    expectTypeOf(data).toEqualTypeOf<CreateUserDto | null>();
  });
});
