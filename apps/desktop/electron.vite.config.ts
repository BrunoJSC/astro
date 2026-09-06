import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

/**
 * Three builds from one config: main, preload, renderer.
 *
 * `externalizeDepsPlugin` keeps node_modules out of the main and preload
 * bundles. They run in Node, so bundling dependencies into them is pure cost --
 * and it breaks any package with a native binding, which is the usual way this
 * shows up.
 *
 * The renderer is bundled normally: it runs in Chromium and has no `require`.
 */
export default defineConfig({
  main: {
    build: {
      lib: { entry: resolve(import.meta.dirname, "electron/main/index.ts") },
      outDir: "out/main",
    },
    plugins: [externalizeDepsPlugin()],
  },

  preload: {
    build: {
      /*
       * CommonJS, and the extension is forced.
       *
       * A SANDBOXED preload cannot be an ES module -- Electron runs it "as
       * plain JavaScript without an ESM context". This package is
       * `"type": "module"`, so the default output was `index.mjs`, which a
       * sandboxed renderer silently fails to load: no bridge, no error, and
       * the app quietly falls back to in-memory credentials.
       *
       * The alternative is turning `sandbox` off, trading the renderer's OS
       * sandbox for a module format. Not worth it -- this preload imports
       * nothing but `electron`.
       */
      lib: {
        entry: resolve(import.meta.dirname, "electron/preload/index.ts"),
        fileName: () => "index.cjs",
        formats: ["cjs"],
      },
      outDir: "out/preload",
    },
    plugins: [externalizeDepsPlugin()],
  },

  renderer: {
    build: {
      /*
       * Explicit, because electron-vite leaves the renderer UNMINIFIED by
       * default -- unlike plain Vite. Measured on this app: 1,566 kB against
       * 711 kB. It ships inside the installer and sits on the user's disk, so
       * the default is simply a silent regression.
       */
      minify: "esbuild",
      outDir: "out/renderer",
      rollupOptions: { input: resolve(import.meta.dirname, "index.html") },
      /*
       * Chromium is bundled, so the target is known rather than guessed. Under
       * Tauri this was `safari13` -- the oldest webview the app might meet --
       * and it is what made top-level await fail to build. Here the runtime
       * ships with the app.
       */
      target: "chrome130",
    },
    /*
     * electron-vite defaults to `RENDERER_VITE_`. Pinned to `VITE_` so the
     * renderer keeps reading the same variables as any other Vite app, and
     * `@repo/env/desktop` stays the single description of them.
     */
    envPrefix: "VITE_",
    plugins: [react()],
    resolve: {
      alias: { "@": resolve(import.meta.dirname, "src") },
    },
    root: import.meta.dirname,
  },
});
