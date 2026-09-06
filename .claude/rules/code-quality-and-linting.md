# Code quality and linting

## The pipeline

`bun run lint:fix` before anything else, `bun run check-types` after. Both must
be green before a task is reported complete. `lefthook.yml` enforces the same
two on every commit, so skipping them locally only moves the failure.

Biome is configured in `biome.jsonc`, extending `ultracite/biome/core` plus
`ultracite/biome/vitest`. `bunx ultracite fix` is equivalent and drives Biome
here — verified with `ultracite doctor`.

## No `any`, and none of its disguises

Explicit `any` is banned. So are the forms that smuggle it in:

- `as any`, and `as unknown as T` used to silence rather than to narrow.
- An untyped `catch` binding used as a value — narrow it with
  `error instanceof Error ? error.message : String(error)`.
- `Function`, `object`, and a bare `{}` as a parameter type.
- An implicitly-`any` array from `const xs = []`. Biome's `noEvolvingTypes`
  catches this and it has already fired in this repository.

`unknown` at a boundary is correct and expected. Everything crossing a wire
arrives as `unknown`: Redis replies, CQL rows, pub/sub payloads, IPC messages.
Narrow it once, at the edge, in the module that owns the wire.

## Cast only where the type system cannot follow

Three casts in this repository are legitimate, and they share a shape: the value
really is what the cast says, and TypeScript has no way to know.

- Branded key builders in `packages/kv/src/keys.ts` — a template literal type
  the compiler cannot infer through `String.prototype` operations.
- `defineCommand` in `packages/kv/src/client.ts` — ioredis attaches Lua scripts
  at runtime, so the interface is declared and asserted once.
- `payload as never` at the Elysia WebSocket boundary.

Each carries a comment saying why. A cast without one is a bug in waiting.

## Dead code

No unused imports, variables, parameters or exports. `noUnusedLocals` and
`noUnusedParameters` are on in `packages/config/base.json`, so this is a
compile error, not a style preference. Prefix a deliberately unused parameter
with `_`.

## Suppressions are documented or refused

Never add a blanket `// biome-ignore` to make a rule quiet. Every rule turned
off in this repository has a written reason, and the reason is measured:

- `noUnnecessaryConditions` is off globally. Measured: 75 s on one 20-line file,
  ~100 s across the repo, **zero findings** in 108 files. It is type-aware and
  resolves into better-auth's and Elysia's declaration files.
- `noAwaitInLoops` is off in `packages/chat-db/src/**` and
  `packages/kv/scripts/**` — the bucket walk is sequential by nature, and the
  rate-limit harness asserts a countdown that only means something in order.
- `noBitwiseOperators` is off in `packages/kv/tests/unit/keys.test.ts` — it
  reimplements Redis Cluster's CRC16/XMODEM, which is shifts and XORs by
  definition.
- `noNamespaceImport` is off in two places, each with a reason in `biome.jsonc`.

Follow that pattern: an override in `biome.jsonc` with a comment stating what
was measured or what breaks, scoped to the narrowest path that works.

## Two Biome behaviours that have already cost time here

**Nested configs replace `files.includes`, they do not merge.** A per-package
`biome.json` silently excluded whole directories while `lint` still reported
green — `apps/web` and `packages/ui` were reporting "Checked 0 files". There is
one root config. Do not add package-level ones.

**Formatting can invalidate a scripted edit.** Biome rewrites code after it is
written, so a `sed`/Python replacement matched against pre-format text will fail
on the second run. Re-read the file after formatting before editing it again.

## Comments earn their place

Comment the decision, not the mechanics. `// increment i` is noise; the reason a
Set has a per-member liveness key beside it is not. Every non-obvious choice in
this repository has a comment explaining the failure it prevents — match that
density rather than the average codebase's.
