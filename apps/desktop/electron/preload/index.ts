import { contextBridge, ipcRenderer } from "electron";
import type { AstroBridge } from "./api";

/**
 * The bridge, and the only place the two worlds touch.
 *
 * `contextBridge` copies these across the isolation boundary as plain values;
 * the page cannot reach back through them to `ipcRenderer` or to anything else
 * in this file's scope.
 *
 * Each method names one channel. Nothing here takes a channel from the caller,
 * because a renderer that can name its own channel can invoke every handler the
 * main process registered.
 */
const bridge: AstroBridge = {
  credentials: {
    backend: () => ipcRenderer.invoke("credentials:backend"),
    clear: () => ipcRenderer.invoke("credentials:clear"),
    get: (key) => ipcRenderer.invoke("credentials:get", key),
    remove: (key) => ipcRenderer.invoke("credentials:remove", key),
    set: (key, value) => ipcRenderer.invoke("credentials:set", key, value),
  },
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  platform: process.platform,
  version: () => ipcRenderer.invoke("app:version"),
};

contextBridge.exposeInMainWorld("astro", bridge);
