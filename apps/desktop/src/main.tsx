import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { Providers } from "./components/providers";
import { loadSessionToken } from "./lib/session-token";
import "./styles/globals.css";

/**
 * Bridge from the HTML shell into React.
 *
 * Revealing the window is no longer this file's job. The main process creates
 * it hidden and shows it on `ready-to-show`, which Chromium fires when the
 * first frame is ready to paint -- a better signal than "React has been asked
 * to render", and one the renderer cannot observe.
 */
const container = document.getElementById("root");

if (!container) {
  throw new Error("#root is missing from index.html");
}

function start(): void {
  if (!container) {
    return;
  }

  createRoot(container).render(
    <StrictMode>
      <Providers>
        <App />
      </Providers>
    </StrictMode>
  );
}

/*
 * The token is read from storage before the first render.
 *
 * `getSessionToken` would read it lazily anyway, but the first request and the
 * first socket connect both fire during mount -- warming it here means neither
 * races the other into an unauthenticated attempt that has to be retried, and a
 * signed-in user never sees a signed-out shell for a frame.
 *
 * A `.then` chain rather than top-level await. It could be an await now that
 * the renderer targets a bundled Chromium -- under Tauri the `safari13` target
 * made esbuild fail the build outright -- but ordering the work explicitly is
 * clearer than relying on module evaluation order.
 *
 * `start` runs either way. A storage backend that cannot be read means the user
 * is treated as signed out, which is recoverable; refusing to render is not.
 */
loadSessionToken()
  .catch(() => undefined)
  .finally(start);
