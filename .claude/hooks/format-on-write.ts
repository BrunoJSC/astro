#!/usr/bin/env bun
/**
 * PostToolUse hook: format and auto-fix whatever was just written.
 *
 * Wired to `Write|Edit` in `.claude/settings.json`. It runs Biome on the single
 * file that changed rather than the tree, so it costs milliseconds and stays
 * out of the way.
 *
 * Written in TypeScript and run with `bun` rather than as a shell script,
 * because this project is developed on Windows and a `.sh` hook does not
 * execute there. Bun is already a hard requirement.
 *
 * Never fails the tool call. A formatter that blocks an edit turns a style
 * preference into a broken workflow; `bun run lint` is the gate that matters,
 * and `post-task-validation` runs it.
 *
 * One consequence worth knowing: because this rewrites files after they are
 * written, a scripted edit matched against pre-format text will miss on the
 * second pass. Re-read a file before editing it again.
 */
import { $ } from "bun";

const LINTABLE = /\.(?:tsx?|jsx?|jsonc?|css)$/;

interface HookInput {
  tool_input?: { file_path?: string };
}

const raw = await Bun.stdin.text();

let filePath: string | undefined;
try {
  filePath = (JSON.parse(raw) as HookInput).tool_input?.file_path;
} catch {
  // No payload, or a shape this hook does not understand. Nothing to do.
  process.exit(0);
}

if (!(filePath && LINTABLE.test(filePath))) {
  process.exit(0);
}

// `--no-errors-on-unmatched` keeps this quiet for a path Biome does not own;
// `--files-ignore-unknown` does the same for an extension it cannot parse.
await $`bunx biome check --write --no-errors-on-unmatched --files-ignore-unknown=true ${filePath}`
  .quiet()
  .nothrow();

process.exit(0);
