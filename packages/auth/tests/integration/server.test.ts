import { describe, expect, it } from "vitest";
import { auth } from "../../src/server";

describe("@repo/auth server", () => {
  it("exposes a fetch-compatible handler", () => {
    expect(typeof auth.handler).toBe("function");
  });

  it("exposes the server-side api surface", () => {
    expect(auth.api).toBeTypeOf("object");
    expect(typeof auth.api.getSession).toBe("function");
  });

  it("answers the session endpoint without a cookie", async () => {
    const res = await auth.handler(
      new Request("http://localhost:3000/api/auth/get-session")
    );
    expect(res.status).toBeLessThan(500);
  });
});
