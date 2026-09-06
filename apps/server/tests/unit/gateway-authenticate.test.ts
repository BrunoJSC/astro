import { describe, expect, it } from "bun:test";
import { tokenFromRequest } from "../../src/modules/gateway/authenticate";

/**
 * The subprotocol parser is the gateway's second untrusted input, after the
 * frame schema. Whatever comes out of it is handed to Better Auth as a
 * credential, so what it refuses matters as much as what it accepts.
 */

const withProtocol = (value: string) =>
  new Request("http://localhost:3001/gateway", {
    headers: { "sec-websocket-protocol": value },
  });

const TOKEN = "aBc123._-XYZ";

describe("tokenFromRequest", () => {
  it("reads the token after the bearer marker", () => {
    expect(tokenFromRequest(withProtocol(`bearer, ${TOKEN}`))).toBe(TOKEN);
  });

  it("tolerates the spacing browsers actually send", () => {
    // Whitespace after the comma is optional in the header grammar, and
    // different clients differ.
    expect(tokenFromRequest(withProtocol(`bearer,${TOKEN}`))).toBe(TOKEN);
    expect(tokenFromRequest(withProtocol(`bearer ,  ${TOKEN}`))).toBe(TOKEN);
  });

  it("finds the pair among other offers", () => {
    expect(tokenFromRequest(withProtocol(`json, bearer, ${TOKEN}`))).toBe(
      TOKEN
    );
  });

  it("returns null when the client offered no subprotocol", () => {
    // The browser case: the cookie rides on the upgrade by itself.
    expect(
      tokenFromRequest(new Request("http://localhost:3001/gateway"))
    ).toBeNull();
  });

  it("returns null for the marker with nothing after it", () => {
    expect(tokenFromRequest(withProtocol("bearer"))).toBeNull();
    expect(tokenFromRequest(withProtocol("bearer, "))).toBeNull();
  });

  it("returns null when the marker is absent", () => {
    expect(tokenFromRequest(withProtocol(`json, ${TOKEN}`))).toBeNull();
  });

  it("rejects anything outside the RFC 6455 token charset", () => {
    // Not politeness about the spec: the value is passed to Better Auth as a
    // credential, and characters that cannot appear in a real token are either
    // a broken client or someone probing.
    for (const bad of ["has space", "semi;colon", 'quote"d', "back\\slash"]) {
      expect(tokenFromRequest(withProtocol(`bearer, ${bad}`))).toBeNull();
    }
  });

  it("accepts every character a Better Auth token can contain", () => {
    // base64url plus the `.` separator.
    const realistic = "K7fJ2-xQ_9aZ.bW3nR8sT1uV5yX0cD6eF4gH";
    expect(tokenFromRequest(withProtocol(`bearer, ${realistic}`))).toBe(
      realistic
    );
  });
});
