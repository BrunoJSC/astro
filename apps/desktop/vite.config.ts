import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite, not Next.js.
 *
 * Tauri serves the frontend as static files over a custom protocol; there is
 * no Node process behind it in a shipped app. Next would have to run in
 * `output: "export"` mode, which drops Server Components, route handlers and
 * middleware -- every feature that justifies it -- or ship a Node runtime
 * inside the installer. Vite is what Tauri targets by default, and the parts
 * of the stack that matter (@repo/ui, Eden Treaty, Better Auth) are all
 * framework-agnostic.
 */
export default defineConfig({
  build: {
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    outDir: "dist",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    // Tauri injects these; they describe the machine the bundle is FOR, not
    // the one building it, which matters for cross-compilation.
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
  },

  // Vite's default is a bare "process.env.X is not defined" at runtime, but
  // Tauri's own error output goes to a terminal the user never sees. Failing
  // loudly in the dev server is the only place a mistake here is visible.
  clearScreen: false,

  envPrefix: ["VITE_", "TAURI_ENV_"],
  plugins: [react()],

  server: {
    // Fixed: `devUrl` in tauri.conf.json points here, and Tauri would load a
    // blank window if Vite silently moved to the next free port.
    port: 1420,
    strictPort: true,
    watch: {
      // The Rust side has its own watcher. Without this, editing a .rs file
      // triggers a frontend reload that races cargo's rebuild.
      ignored: ["**/src-tauri/**"],
    },
  },
});
