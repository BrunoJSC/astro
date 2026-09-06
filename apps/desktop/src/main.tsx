import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { Providers } from "./components/providers";
import { loadSessionToken } from "./lib/session-token";
import "./styles/globals.css";

/**
 * Bridge from the HTML shell into React.
 *
 * The window is created hidden (`"visible": false` in tauri.conf.json) and
 * shown here, after the first render has been committed. A Tauri window
 * otherwise appears as a white rectangle for as long as the bundle takes to
 * parse -- brief on a fast machine, very visible on a cold start.
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

  /*
   * Deliberately not awaited: showing the window is a side effect of the app
   * being ready, and a failure here (a webview that does not grant the
   * permission) must not take the UI down with it.
   */
  getCurrentWindow()
    .show()
    .catch(() => {
      // The window stays hidden rather than the app crashing; the capability in
      // src-tauri/capabilities/default.json is what grants this.
    });
}

/*
 * The token is read from storage before the first render.
 *
 * `getSessionToken` would read it lazily anyway, but the first request and the
 * first socket connect both fire during mount -- warming it here means neither
 * races the other into an unauthenticated attempt that has to be retried, and a
 * signed-in user never sees a signed-out shell for a frame.
 *
 * A `.then` chain rather than top-level await, and not stylistically: Tauri
 * builds target `safari13` (see vite.config.ts), where top-level await does not
 * exist. esbuild fails the build outright rather than transpiling it.
 *
 * `start` runs either way. A storage backend that cannot be read means the user
 * is treated as signed out, which is recoverable; refusing to render is not.
 */
loadSessionToken()
  .catch(() => undefined)
  .finally(start);
