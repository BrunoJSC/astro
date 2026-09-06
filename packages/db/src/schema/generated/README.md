# Generated reference — do not edit

`better-auth.ts` is the verbatim output of `bun run auth:generate` (in
`@repo/auth`). It is **not** the schema the application uses.

It is kept here, versioned and byte-identical to what the CLI emits, so that
upgrading Better Auth produces a reviewable diff. Nothing imports it except
`../drift.test.ts`.

## Why the real schema differs

The tables in `../` are the source of truth and diverge deliberately:

| Ours | Generated | Why |
|---|---|---|
| `timestamp(..., { withTimezone: true })` | `timestamp(...)` | A session expiry without a timezone is wrong the moment the app and the database disagree on one. |
| `text("id").$defaultFn(newId)` | `text("id")` | UUIDv7 primary keys, so rows inserted directly through Drizzle get the same id format Better Auth generates. |
| `account(provider_id, account_id)` index | — | The OAuth callback lookup. |
| `verification(identifier, value)` index | — | The token-consumption lookup. |

The generator has **no option** for any of these — it emits plain `timestamp()`
unconditionally, and there is no `withTimezone` or timezone setting anywhere in
`@better-auth/cli`. So re-running it against `../` would silently revert all
four changes.

## The workflow

1. Upgrade `better-auth`, then run `bun run auth:generate` in `@repo/auth`.
2. Review the diff on this file. An unchanged file means nothing to do.
3. If a column was added, renamed or re-nullabled, `../drift.test.ts` fails and
   names it. Apply the same change to the matching file in `../`.

The drift test compares table names, column names, nullability and column type.
It ignores the divergences above by construction: `timestamptz` and `timestamp`
both report `columnType: "PgTimestamp"`, extra defaults are allowed in one
direction only, and indexes are not compared at all.
