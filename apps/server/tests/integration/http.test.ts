import { describe, expect, it } from "vitest";
import { app } from "../../src/index";

const call = (path: string, init?: RequestInit) =>
  app.handle(new Request(`http://localhost${path}`, init));

describe("health routes", () => {
  it("serves /health", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
  });

  it("serves /health/ready with uptime", async () => {
    const res = await call("/health/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; uptime: number };
    expect(body.status).toBe("ready");
    expect(body.uptime).toBeGreaterThan(0);
  });
});

describe("v1 routes", () => {
  it("401s /v1/me without a session cookie", async () => {
    const res = await call("/v1/me");
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      message: "Not authenticated",
    });
  });
});

describe("auth routes", () => {
  it("forwards /api/auth/* to Better Auth rather than 404ing", async () => {
    const res = await call("/api/auth/get-session");
    expect(res.status).not.toBe(404);
    expect(res.status).toBeLessThan(500);
  });
});

describe("cors", () => {
  it("reflects an allowed origin with credentials", async () => {
    const res = await call("/health", {
      headers: { Origin: "http://localhost:3000" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000"
    );
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});

describe("openapi", () => {
  it("serves the Scalar docs page at /docs", async () => {
    const res = await call("/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("serves the OpenAPI document with the declared routes", async () => {
    const res = await call("/docs/json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(["/health", "/health/ready", "/v1/me"])
    );
  });
});

describe("unknown routes", () => {
  it("404s", async () => {
    const res = await call("/nope");
    expect(res.status).toBe(404);
  });
});
