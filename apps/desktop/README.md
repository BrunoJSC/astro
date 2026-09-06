# @repo/desktop

Tauri v2 desktop client. React frontend, Rust shell.

```bash
bun run dev:desktop      # from the repo root
bun tauri dev            # from this directory
bun tauri build          # installer in src-tauri/target/release/bundle
```

The API must be running (`bun run dev:server`), and `.env` must exist here —
copy `.env.example`.

### Why `build` is not `tauri build`

`bun run build` here compiles the **frontend only**, and `bun run build:app`
(or `bun tauri build`) produces the native installer.

The split is not cosmetic. `build` is what `turbo run build` invokes across the
whole monorepo, and pointing it at `tauri build` makes every repo-wide build —
and CI — depend on a Rust toolchain and platform SDKs, to produce an installer
nobody asked for. It also cannot be cached usefully: the output is a signed
bundle for one platform. Shipping an installer is a release step with its own
requirements, so it gets its own script.

---

## Status: the Rust half has never been compiled

The frontend is verified: `vite build` produces a bundle, `tsc` passes, Biome
passes. The Rust side has not been built even once. This was written on a
borrowed machine with no Rust toolchain and no Xcode, so `cargo` could not run.

`bun tauri info` does parse `tauri.conf.json` and `Cargo.toml` and reports the
config back correctly, which rules out malformed manifests — but that is
parsing, not compiling. Expect the first `bun tauri dev` on a real machine to
surface something: a dependency version that does not resolve, a plugin whose
v2 API drifted, a missing platform library.

First run on a machine with the toolchain:

```bash
rustup --version || curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cd apps/desktop && bun tauri dev
```

The first build compiles the whole dependency tree and takes several minutes.
Delete this section once it has run.

---

## Why Vite and not Next.js

Tauri serves the frontend as static files over a custom protocol; a shipped app
has no Node process behind it. Next would have to run in `output: "export"`,
which drops Server Components, route handlers and middleware — everything that
justifies choosing it — or ship a Node runtime inside the installer. Vite is
what Tauri targets by default, and the pieces that matter here (`@repo/ui`,
Eden Treaty, Better Auth) are framework-agnostic.

The web app stays on Next. Nothing is duplicated between them except the
provider tree, which is 20 lines.

## Layout

```
index.html               the shell Vite compiles; entry is src/main.tsx
vite.config.ts           port 1420 fixed, src-tauri excluded from the watcher
src/
  main.tsx               React root, and where the window is revealed
  app.tsx                entry screen; checks all four seams are live
  env.ts                 validated VITE_* — see the note below
  lib/eden.ts            typed client against apps/server
  lib/auth-client.ts     Better Auth, desktop flavour
  components/providers.tsx
  styles/globals.css     imports @repo/ui/styles, plus desktop-only base rules
src-tauri/
  tauri.conf.json        window, CSP, bundle, deep-link scheme
  Cargo.toml             crate is a lib + thin bin, so mobile can reuse run()
  src/main.rs            binary entry; hides the Windows console in release
  src/lib.rs             plugin registration and the IPC handler
  capabilities/          what the main window may ask Rust to do
  icons/                 placeholders — regenerate with `bun tauri icon <logo.png>`
```

## Three things that are easy to get wrong

**The environment is spelled out, not spread.** Vite inlines `import.meta.env.VITE_*`
by literal text substitution, so `...import.meta.env` compiles to an object that
is empty in a production build while type-checking perfectly. The failure shows
up as a request to `undefined/auth` in a shipped binary. `src/env.ts` lists every
key; the schema lives in `@repo/env/desktop`, which is a schema map only for
exactly this reason.

**The app has three origins, not one.** `http://localhost:1420` is only the Vite
dev server. A packaged window is served from `tauri://localhost` on macOS and
Linux, and `http://tauri.localhost` on Windows. All three belong in the server's
`CORS_ORIGINS`, or the app works throughout development and fails on the first
machine that installs it.

**Sessions are bearer tokens, not cookies.** A packaged window is served from
`tauri://localhost`, so the API's cookie is third-party to it and both WKWebView
and WebView2 block those by default — sign-in would appear to succeed and the
session would be gone on the next request. So `@repo/auth` registers Better
Auth's `bearer()` plugin: it returns the session token in a `set-auth-token`
header on sign-in and accepts it back as `Authorization: Bearer`.
`lib/auth-client.ts` captures and sends it; `lib/session-token.ts` holds it.

Where it is held is the weak part — see below.

## Credential storage is not the OS keychain

`lib/storage/` is the adapter: one `ISecureStorage` contract, three backends,
chosen at runtime by whether `window.__TAURI_INTERNALS__` exists. A Tauri window
gets `@tauri-apps/plugin-store`; a browser or plain `vite dev` tab gets
`localStorage`, which degrades to memory when the browser refuses it; anything
with no `window` gets memory.

None of them is the OS keychain, and the plugin names invite the opposite
assumption:

- **`plugin-store` does not encrypt.** It is a JSON file in the app's data
  directory. Against a process running as the same user it is exactly as exposed
  as `localStorage`. What it buys is a file the app owns, outside the webview's
  storage, that survives a cleared cache and can be deleted deterministically.
- **`plugin-stronghold` is not the keychain either.** It is an IOTA vault written
  to an encrypted `.hold` snapshot, and it must be opened with a password. For an
  app that signs the user in without prompting, that password has to live
  somewhere the app can read unattended — which is the original problem, one
  indirection down.
- **Tauri v2 ships no official keychain plugin.** Reaching Keychain, Credential
  Manager or Secret Service needs a community crate and a pair of Rust commands.

So the token is plaintext on disk today. Every backend reports its own
`durability` (`ephemeral` / `plaintext` / `encrypted`) so calling code can ask
rather than assume, and the app surfaces it on screen. Moving to the keychain is
one new backend in `lib/storage/` and one line in `getSecureStorage`.

## The gateway

`lib/gateway.ts` is the client for the server's realtime socket, and
`lib/gateway-store.ts` holds one connection for the whole app — a hook that owned
the socket would open one per component.

The frame types are imported from `@repo/server/gateway/model` as types only, so
the contract is the server's own definition rather than a copy that drifts. The
import is erased at compile time; nothing from Elysia reaches the bundle.

The token travels as a WebSocket subprotocol — `new WebSocket(url, ["bearer",
token])` — because the WebSocket API cannot set an `Authorization` header, and a
query string would put the session token into every proxy and access log it
passes through.

Reconnection is exponential backoff with **full jitter**, and the jitter is not
politeness: when a server node dies every client it held reconnects at once, and
a fixed delay makes them arrive together, knock over whichever node they land on,
and repeat. A close with code 4001 is terminal — retrying a rejected credential
just burns connections.

## Rust is for what only a native process can do

`src/lib.rs` exposes one command, `app_version`, and it exists to prove the IPC
bridge works. Domain logic does not go there: the app talks to `apps/server`
over HTTP through Eden Treaty, so web, native and desktop share one typed
contract. Commands are for tray icons, notifications, global shortcuts, file
dialogs — the things a webview cannot reach.

Every command needs a matching permission in `src-tauri/capabilities/default.json`.
Tauri v2 denies by default; a call with no permission fails at runtime, not at
compile time.
