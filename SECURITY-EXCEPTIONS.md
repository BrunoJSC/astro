# Accepted advisories

`security:check` fails the build on any advisory of severity **high** or above.
The exceptions below are passed to `bun audit --ignore` in the root
`package.json`. Each one needs a reason, and gets removed as soon as an
upstream fix exists.

Re-check with `bun run security:audit`, which applies no ignores at all.

## GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr — `image-size` <= 2.0.2

Denial of service through infinite loops in the ICNS, JXL and HEIF parsers.

- **Reached through:** Metro, three levels down from `expo`, `react-native` and
  `react-native-reanimated`. Nothing in the repo depends on `image-size`
  directly.
- **Why accepted:** `bun audit fix` reports *no published version fixes* it —
  Metro pins the vulnerable range, so there is nothing to upgrade to. The
  parser runs in the bundler at build time, on the developer's or CI's own
  assets; it is not in the shipped app, and does not process untrusted input.
- **Remove when:** Metro ships a release depending on `image-size` > 2.0.2.
  Check with `bun audit fix --dry-run`.

---

# Deploy secrets

The deploy workflows fail loudly without these. Set them with
`gh secret set <NAME>` / `gh variable set <NAME>`.

| Name | Kind | Used by |
|---|---|---|
| `NEON_API_KEY` | secret | preview-db |
| `NEON_PROJECT_ID` | secret | preview-db |
| `DATABASE_URL` | secret | migrate |
| `DIRECT_URL` | secret | migrate — the non-pooled endpoint |
| `VERCEL_TOKEN` | secret | deploy-web |
| `VERCEL_ORG_ID` | secret | deploy-web |
| `VERCEL_PROJECT_ID` | secret | deploy-web |
| `RAILWAY_TOKEN` | secret | deploy-server |
| `RAILWAY_SERVICE` | variable | deploy-server |
| `SERVER_URL` | variable | deploy-server — the health probe target |
| `EXPO_TOKEN` | secret | build-native |
| `EXPO_PUBLIC_API_URL` | variable | build-native — inlined into the bundle |

## Environments

`production`, `production-web` and `production-server` exist, each restricted
to the `main` branch. Referencing them scopes secrets per workflow.

**Required reviewers are not active.** GitHub allows environment protection
rules on private repositories only from the Pro plan up; the API rejects them
here with *"Please ensure the billing plan supports the required reviewers
protection rule"*. Two ways to get the real approval gate:

- GitHub Pro on the account, or
- make the repository public.

Until then `migrate` is guarded by being dispatch-only, by a typed
confirmation, by the branch policy, and by printing the pending SQL to the run
summary before it writes.
