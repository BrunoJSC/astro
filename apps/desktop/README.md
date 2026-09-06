# @repo/desktop

Electron desktop client. React renderer, Node main process.

```bash
bun run dev:desktop      # from the repo root
bun run dev              # from this directory
bun run build            # bundles main, preload and renderer into out/
bun run build:app        # installer in release/
```

The API must be running (`bun run dev:server`), and `.env` must exist here —
copy `.env.example`.

---

## Status: launches, and safeStorage is real

Verified on macOS 12.7.6 by running the built `out/main/index.js` and driving the
renderer over the Chrome DevTools Protocol:

- the window opens and the renderer loads with no console errors;
- the preload bridge is present — `window.astro` exposes exactly
  `credentials, openExternal, platform, version`;
- `credentials.backend()` reports
  `{ encrypted: true, name: "safeStorage (Keychain)" }`;
- a value written through the bridge reads back, and disappears after
  `remove`;
- the file on disk is `-rw-------`, begins with Chromium's `v10` encryption
  marker, and **does not contain the token in plaintext**.

Two things are still unverified: `bun run dev` (electron-vite's dev server plus
HMR was never started) and `bun run build:app` (no installer has been produced).

### Electron 44 does not run on macOS 12

The pinned version fails to launch here with `Symbol not found:
_OBJC_CLASS_$_SMAppService`, which is macOS 13+. The verification above used a
throwaway Electron 40 against the same built output.

The pin stays at 44 deliberately — an older Electron means an older Chromium and
its CVEs, which is a bad trade to make for one development machine. If you need
to run it on Monterey, install `electron@40` locally rather than changing the
pin.

---

## Why Electron, after starting on Tauri

Tauri does not bundle a browser engine; it renders in the OS webview. For a
Discord-style client that is disqualifying, and not because of papercuts:

| | Voice (`getUserMedia`) | Screen (`getDisplayMedia`) |
| --- | --- | --- |
| Windows / WebView2 | works | works |
| macOS / WKWebView | works | **unsupported** |
| Linux / WebKitGTK | **limited** | limited |

`voice.join`, `peerId` and `selfMute` are already in the schema, in Redis and in
the gateway. Voice is scope, and on Tauri the feature would be broken on two of
three platforms with no fix available from application code. Electron bundles
Chromium, so WebRTC behaves the same everywhere, and `desktopCapturer` exists
for picking a window or screen.

Three things came along with it, none of which would have justified the move
alone:

- **`safeStorage`** — a first-party keychain API. Under Tauri the session token
  was plaintext on disk, because v2 ships no keychain plugin.
- **No Rust toolchain.** The `src-tauri` crate never compiled on the machine
  this was written on; there is nothing left to compile.
- **One engine.** Both bugs hit while building the Tauri version were instances
  of the same cause: `safari13` breaking top-level await, and `tauri://localhost`
  having no cookie jar for the API.

The costs are real: a ~150MB installer against ~15MB, higher idle memory, and
Chromium updates become a security obligation rather than a convenience — an
Electron app without auto-update ships known CVEs.

The migration itself was cheap because it happened early: six lines of the
renderer were Tauri-specific.

## Layout

```
electron/
  main/index.ts          window, security policy, app lifecycle
  main/credentials.ts    safeStorage + the file it persists to
  preload/index.ts       the contextBridge — the only way in
  preload/api.ts         the bridge's type, shared with the renderer
src/                     the renderer, unchanged from the Tauri version
  lib/storage/           ISecureStorage and its backends
  lib/gateway.ts         client for the server's realtime socket
electron.vite.config.ts  three builds: main, preload, renderer
electron-builder.yml     packaging, read only by build:app
```

## Security is decided in `electron/main/index.ts`

Electron's defaults are safe today, but everything that makes an Electron app
dangerous is a decision that file makes, so each is closed explicitly rather
than left to a default that could change:

- `sandbox`, `contextIsolation`, `nodeIntegration: false` — with all three, the
  renderer's entire reach into the OS is the handful of methods in the preload.
- `setWindowOpenHandler` denies every new window and sends the URL to the real
  browser. An OAuth page in an app window is blocked by most providers anyway,
  and a popup with no address bar is where phishing lives.
- `will-navigate` blocks navigating away — there is no address bar to come back
  with.
- `openExternal` **validates the scheme**. `shell.openExternal` hands anything
  to the platform handler, including `file://`, `smb://` and on Windows schemes
  that execute. Without the check, "open a link" becomes "run a program" for a
  compromised renderer.
- A CSP is set on every response from the main process, so one policy covers the
  dev server and the packaged `file://` load, and the API origin is not
  duplicated into HTML.

## The preload is CommonJS on purpose

A **sandboxed** preload cannot be an ES module — Electron runs it "as plain
JavaScript without an ESM context". This package is `"type": "module"`, so
electron-vite's default output was `index.mjs`, which the sandboxed renderer
fails to load *silently*: no bridge, no error, and the app quietly falls back to
in-memory credentials. So the preload build is pinned to `cjs` with an explicit
`index.cjs` filename, and the main process loads that path.

Turning `sandbox` off would also fix it, and trades the renderer's OS sandbox
for a module format. Not a trade worth making for a preload that imports nothing
but `electron`.

## Credentials

`lib/storage/` is the adapter: one `ISecureStorage` contract, three backends,
chosen at runtime by whether the preload bridge exists. Electron gets
`safeStorage`; a browser or dev-server tab gets `localStorage`, degrading to
memory; anything with no `window` gets memory.

Two things about `safeStorage` are easy to get wrong, and both are handled in
`electron/main/credentials.ts`:

- **It does not persist.** `encryptString` returns a Buffer and stops there.
  Writing the ciphertext is the app's job — it goes to `userData`, mode `0600`.
- **On Linux it may not encrypt.** With no secret service running,
  `getSelectedStorageBackend()` returns `basic_text`, meaning a hardcoded
  password, which protects nothing. `durability()` reports `plaintext` in that
  case rather than claiming otherwise, and the app shows it on screen.

`durability()` is async for exactly that reason: the honest answer is only known
after asking the main process which backend the OS actually handed over.

## The gateway

`lib/gateway.ts` is the client for the server's realtime socket, and
`lib/gateway-store.ts` holds one connection for the whole app — a hook that
owned the socket would open one per component.

Frame types are imported from `@repo/server/gateway/model` as types only, so the
contract is the server's own definition rather than a copy that drifts, and
nothing from Elysia reaches the bundle.

The session token travels as a WebSocket subprotocol — `new WebSocket(url,
["bearer", token])` — because the WebSocket API cannot set an `Authorization`
header, and a query string would put the token into every proxy and access log
it passes through. That path was built for Tauri's missing cookie jar and is
still the right one here: a packaged renderer loads from `file://`, whose origin
is opaque.

Reconnection is exponential backoff with **full jitter**, and the jitter is not
politeness: when a server node dies every client it held reconnects at once, and
a fixed delay makes them arrive together, knock over whichever node they land
on, and repeat. A close with code 4001 is terminal — retrying a rejected
credential just burns connections.

## Known gaps

- **No auto-update.** Electron makes this mandatory rather than optional: you
  now ship Chromium, so you own its CVEs. `electron-updater` pairs with the
  `electron-builder.yml` already here.
- **Unsigned builds.** `mac.identity` is null, so a distributed `.dmg` is
  quarantined by macOS. Real distribution needs an Apple Developer identity and
  notarisation, and a Windows signing certificate.
- **No tray, global shortcuts or `desktopCapturer` wiring yet.** They are the
  reason Electron was chosen; none are built.
