# Hooks

Two, both TypeScript run through `bun`. Not shell scripts: this project is
developed on Windows, where a `.sh` hook does not execute. Bun is already a hard
requirement, so it is the one interpreter guaranteed to be present.

Wired in `.claude/settings.json`.

| Hook | Event | Blocks? | Cost |
| --- | --- | --- | --- |
| `format-on-write.ts` | `PostToolUse` on `Write`/`Edit` | no | ~1s, one file |
| `post-task-validation.ts` | `Stop` | yes, on lint/types/test | ~25s, or ~0 when nothing changed |

## `format-on-write.ts`

Runs Biome with `--write` on the single file that was just written. It never
fails the tool call — a formatter that blocks an edit turns a style preference
into a broken workflow.

Because it rewrites files after they are written, a scripted edit matched
against pre-format text will miss on a second pass. Re-read before editing
again.

## `post-task-validation.ts`

Runs `lint`, `check-types`, `test` and `security:check` when the turn ends, and
exits 2 if any of the first three fail — which feeds the failure back to the
agent instead of letting a task be reported complete on a red pipeline.

Two deliberate softenings:

- **It short-circuits.** It asks git whether any source file changed and exits
  immediately if not, so a turn that only answered a question costs nothing.
- **The audit does not block.** `bun audit` needs the network, and a blocking
  hook that cannot pass offline traps the agent in a loop with no way out. Its
  result is printed, not enforced. Lefthook's pre-push job is the real gate.

## Relationship to git hooks

These are **not** git hooks. `lefthook.yml` owns those, and it is the one that
runs on `git commit` and `git push` regardless of which tool made the change:

| | Claude Code hooks | Lefthook |
| --- | --- | --- |
| Fires on | tool use, turn end | commit, push |
| Applies to | edits made by the agent | every commit, by anyone |

Both run Biome and `check-types`, deliberately. The Claude Code hooks catch a
problem seconds after it is written; lefthook catches whatever reached the
index anyway.

## Turning them off

Delete the entry from `.claude/settings.json`, or override it in
`.claude/settings.local.json`, which is gitignored and takes precedence.

`.claude/settings.json` is committed, so it applies to everyone who clones the
repository. Hooks execute arbitrary commands — treat a change to this file as
you would a change to a CI workflow, and read it before accepting one from a
pull request.
