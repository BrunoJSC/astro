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
