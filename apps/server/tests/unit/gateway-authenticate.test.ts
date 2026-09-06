import { describe, expect, it } from "bun:test";
import { tokenFromRequest } from "../../src/modules/gateway/authenticate";

const B64_PLUS = /\+/g;
const B64_SLASH = /\//g;
const B64_PADDING = /[=]+$/;

/**
 * The subprotocol parser is the gateway's second untrusted input, after the
 * frame schema. Whatever comes out of it is handed to Better Auth as a
 * credential, so what it refuses matters as much as what it accepts.
 */

const withProtocol = (value: string) =>
  new Request("http://localhost:3001/gateway", {
    headers: { "sec-websocket-protocol": value },
  });

/**
 * What travels: base64url. The tests below encode a realistic token and assert
 * the decoded value comes back, because the wire form and the credential are
 * no longer the same string.
 */
const encode = (raw: string) =>
  btoa(raw)
    .replace(B64_PLUS, "-")
    .replace(B64_SLASH, "_")
    .replace(B64_PADDING, "");

const RAW = "fCNDzw8AvDU0kQCUbm8P.s7RhtjL7UWviMxn0GEUD1M0Vhrgy1vQxhh0WppcLP+A=";
const TOKEN = encode(RAW);

describe("tokenFromRequest", () => {
  it("decodes the token that follows the bearer marker", () => {
    expect(tokenFromRequest(withProtocol(`bearer, ${TOKEN}`))).toBe(RAW);
  });

  it("carries a real Better Auth token, which contains `=`", () => {
    /*
     * The bug this encoding exists for. A Better Auth token is padded base64,
     * so it ends in `=` -- which is not an RFC 7230 `tchar`, and the browser
     * refuses to build the socket rather than the server refusing the value.
     * Found by asserting a real token against the charset, not a fabricated one.
     */
    expect(RAW).toContain("=");
    expect(TOKEN).not.toContain("=");
    expect(tokenFromRequest(withProtocol(`bearer, ${TOKEN}`))).toBe(RAW);
  });

  it("tolerates the spacing browsers actually send", () => {
    // Whitespace after the comma is optional in the header grammar, and
    // different clients differ.
    expect(tokenFromRequest(withProtocol(`bearer,${TOKEN}`))).toBe(RAW);
    expect(tokenFromRequest(withProtocol(`bearer ,  ${TOKEN}`))).toBe(RAW);
  });

  it("finds the pair among other offers", () => {
    expect(tokenFromRequest(withProtocol(`json, bearer, ${TOKEN}`))).toBe(RAW);
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
    for (const bad of ["has space", "semi;colon", 'quote"d', "not+base64url"]) {
      expect(tokenFromRequest(withProtocol(`bearer, ${bad}`))).toBeNull();
    }
  });

  it("rejects a value that is not base64url at all", () => {
    // `.` was legal as a subprotocol token and is not legal base64url, so the
    // guard moved rather than loosened.
    expect(tokenFromRequest(withProtocol("bearer, has.dots"))).toBeNull();
  });
});
