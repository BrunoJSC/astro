import { edenQuery } from "@repo/server/eden";
import { Button } from "@repo/ui/components";
import { useQuery } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-shell";
import { useEffect } from "react";
import { useSession } from "./lib/auth-client";
import { api } from "./lib/eden";
import { useGateway } from "./lib/gateway-store";
import { getSecureStorage, isTauri } from "./lib/storage";

/**
 * The entry screen, and a live check that every seam is wired: the design
 * system renders, Eden reaches the API, Better Auth reads a session, the Rust
 * side answers over IPC, and the gateway socket is up.
 *
 * Replace it with the real shell -- guild rail, channel list, message view.
 */

const REPOSITORY_URL = "https://github.com/BrunoJSC/astro";

function openRepository() {
  // `open` hands the URL to the OS browser instead of navigating the webview.
  // Navigating away would replace the app with a web page and leave no way
  // back -- there is no address bar.
  open(REPOSITORY_URL);
}

export function App() {
  const health = useQuery(edenQuery(["health"], () => api.health.get()));
  const version = useQuery({
    queryFn: () => getVersion(),
    queryKey: ["app-version"],
  });
  const session = useSession();

  const gatewayStatus = useGateway((state) => state.status);
  const connect = useGateway((state) => state.connect);
  const disconnect = useGateway((state) => state.disconnect);

  /*
   * The socket follows the session. Connecting while signed out would be
   * rejected with 4001 and put the client into its terminal `unauthorised`
   * state, which no amount of retrying leaves.
   */
  useEffect(() => {
    if (session.data) {
      connect();
      return disconnect;
    }
  }, [session.data, connect, disconnect]);

  return (
    <main className="flex h-full flex-col items-center justify-center gap-6 bg-background p-8 text-foreground">
      <header className="text-center">
        <h1 className="font-semibold text-2xl">Astro</h1>
        <p className="selectable text-muted-foreground text-sm">
          Tauri v2 · React · {version.data ?? "…"}
        </p>
      </header>

      <dl className="grid w-full max-w-sm grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">API</dt>
        <dd className="selectable text-right">{describe(health)}</dd>

        <dt className="text-muted-foreground">Session</dt>
        <dd className="selectable text-right">
          {session.isPending
            ? "checking…"
            : (session.data?.user.name ?? "signed out")}
        </dd>

        <dt className="text-muted-foreground">Gateway</dt>
        <dd className="selectable text-right">{gatewayStatus}</dd>

        <dt className="text-muted-foreground">Credentials</dt>
        <dd className="selectable text-right">
          {getSecureStorage().name}
          <span className="text-muted-foreground">
            {" "}
            ({getSecureStorage().durability})
          </span>
        </dd>

        <dt className="text-muted-foreground">Runtime</dt>
        <dd className="selectable text-right">
          {isTauri() ? "tauri" : "browser"}
        </dd>
      </dl>

      <Button onClick={openRepository}>Open the repository</Button>
    </main>
  );
}

function describe(query: {
  isPending: boolean;
  isError: boolean;
  error: Error | null;
}): string {
  if (query.isPending) {
    return "connecting…";
  }
  return query.isError ? (query.error?.message ?? "unreachable") : "ok";
}
