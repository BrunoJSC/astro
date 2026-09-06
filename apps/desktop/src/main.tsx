import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { Providers } from "./components/providers";
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

createRoot(container).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>
);

/*
 * Deliberately not awaited before render: showing the window is a side effect
 * of the app being ready, and a failure here (a webview that does not grant
 * the permission) must not take the UI down with it.
 */
getCurrentWindow()
  .show()
  .catch(() => {
    // The window stays hidden rather than the app crashing; the capability in
    // src-tauri/capabilities/default.json is what grants this.
  });
