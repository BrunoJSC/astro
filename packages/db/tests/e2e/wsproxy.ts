import { connect, type Socket } from "node:net";

/**
 * A WebSocket-to-TCP tunnel, so the tests can use the production driver.
 *
 * `@neondatabase/serverless` speaks the Postgres wire protocol over a
 * WebSocket, because that is the only transport available in the edge runtimes
 * it targets. Neon terminates that at its own proxy; pointed at a plain
 * Postgres it has nothing to talk to.
 *
 * The alternative was to test through `pg` and `drizzle-orm/node-postgres`,
 * which would exercise a driver this project does not ship. Forty lines of
 * tunnel buys the real path instead: the same `Pool`, the same
 * `drizzle-orm/neon-serverless` adapter, the same `configureForHost` branch
 * that had never been executed.
 *
 * It implements only what the driver asks for: an upgrade at any path with
 * `?address=host:port`, then bytes in both directions. No TLS -- which is
 * exactly what `configureForHost` switches the driver to for a local host.
 */

export interface WsProxy {
  readonly port: number;
  stop: () => void;
}

interface Tunnel {
  buffered: Uint8Array[];
  ready: boolean;
  tcp: Socket;
}

export function startWsProxy(): Promise<WsProxy> {
  return new Promise((resolve) => {
    const server = Bun.serve<Tunnel, never>({
      fetch(request, self) {
        const address = new URL(request.url).searchParams.get("address");
        if (!address) {
          return new Response("missing address", { status: 400 });
        }

        const [host = "127.0.0.1", port = "5432"] = address.split(":");
        const tcp = connect({ host, port: Number(port) });

        const upgraded = self.upgrade(request, {
          data: { buffered: [], ready: false, tcp },
        });

        return upgraded
          ? undefined
          : new Response("expected websocket", { status: 426 });
      },
      port: 0,
      websocket: {
        close(ws) {
          ws.data.tcp.destroy();
        },
        message(ws, message) {
          const bytes =
            typeof message === "string"
              ? new TextEncoder().encode(message)
              : new Uint8Array(message);

          /*
           * The upgrade completes before the TCP socket does. Anything the
           * driver sends in that window -- and it sends the startup packet
           * immediately -- has to be held, or the connection dies on a write
           * to a socket that is not open yet.
           */
          if (ws.data.ready) {
            ws.data.tcp.write(bytes);
          } else {
            ws.data.buffered.push(bytes);
          }
        },
        open(ws) {
          const { tcp } = ws.data;

          tcp.on("connect", () => {
            ws.data.ready = true;
            for (const chunk of ws.data.buffered) {
              tcp.write(chunk);
            }
            ws.data.buffered.length = 0;
          });

          tcp.on("data", (chunk: Buffer) => ws.send(chunk));
          tcp.on("close", () => ws.close());
          tcp.on("error", () => ws.close());
        },
      },
    });

    resolve({
      // `port: 0` asks the OS to pick one; Bun fills it in before `serve`
      // returns, so this is never actually undefined.
      port: server.port ?? 0,
      stop: () => server.stop(true),
    });
  });
}
