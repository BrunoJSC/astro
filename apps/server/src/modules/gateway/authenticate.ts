import { auth } from "@repo/auth/server";

/**
 * Who is on the other end of an upgrade request.
 *
 * Two ways in, because the browser WebSocket API allows neither of the usual
 * ones to be chosen freely.
 *
 * **Cookie.** Sent automatically on the upgrade, and what `apps/web` uses. It
 * needs nothing here -- `authPlugin`'s derive already resolved it before this
 * runs.
 *
 * **Subprotocol.** For clients with no cookie jar for the API's origin: a Tauri
 * window served from `tauri://localhost`, and React Native. `new WebSocket(url,
 * ["bearer", token])` puts the value in `Sec-WebSocket-Protocol`, which is the
 * only client-controlled header the API exposes -- `Authorization` cannot be
 * set on a WebSocket at all.
 *
 * A query string would also work and is what most tutorials show. It is avoided
 * on purpose: URLs are written to proxy logs, access logs and browser history
 * as a matter of course, and a session token in any of those is a session token
 * leaked. Headers are not routinely logged.
 */

const SUBPROTOCOL = "bearer";

/**
 * RFC 6455 says a subprotocol is a `token` -- the HTTP token charset.
 *
 * Enforced rather than trusted: the value reaches Better Auth, and anything
 * outside this set is either a malformed client or someone probing. Better Auth
 * tokens are base64url with a `.` separator, all of which is inside it.
 */
const SUBPROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export interface SocketIdentity {
  /** Echoed back in the upgrade response when the client used a subprotocol. */
  acceptedProtocol: string | null;
  userId: string;
}

/**
 * Pulls the token out of `Sec-WebSocket-Protocol`.
 *
 * The header is a comma-separated list of offers; this looks for the pair
 * `bearer, <token>`. Returns null when the client did not offer one, which is
 * the normal case for a browser using its cookie.
 */
export function tokenFromRequest(request: Request): string | null {
  const offered = request.headers.get("sec-websocket-protocol");
  if (!offered) {
    return null;
  }

  const parts = offered.split(",").map((part) => part.trim());
  const at = parts.indexOf(SUBPROTOCOL);
  const token = at === -1 ? undefined : parts[at + 1];

  if (!(token && SUBPROTOCOL_TOKEN.test(token))) {
    return null;
  }

  return token;
}

/**
 * Resolves the socket's user, preferring the session the cookie already gave us.
 *
 * `cookieUserId` is whatever `authPlugin` derived. When it is present nothing
 * else happens -- a browser must not be able to widen its own identity by also
 * offering a token.
 */
export async function authenticateSocket(
  request: Request,
  cookieUserId: string | undefined
): Promise<SocketIdentity | null> {
  if (cookieUserId) {
    return { acceptedProtocol: null, userId: cookieUserId };
  }

  const token = tokenFromRequest(request);
  if (!token) {
    return null;
  }

  /*
   * The `bearer()` plugin registered in @repo/auth turns this header into the
   * session cookie the rest of Better Auth expects, so this is the same lookup
   * the cookie path performs -- same expiry checks, same revocation, no second
   * notion of what a valid session is.
   */
  const result = await auth.api.getSession({
    headers: new Headers({ authorization: `Bearer ${token}` }),
  });

  if (!result?.user) {
    return null;
  }

  /*
   * The subprotocol is echoed back because the client offered one. A browser
   * fails the connection if the server selects a protocol that was not offered;
   * selecting the one that was is the only correct answer. The token half is
   * never echoed -- only the marker.
   */
  return { acceptedProtocol: SUBPROTOCOL, userId: result.user.id };
}
