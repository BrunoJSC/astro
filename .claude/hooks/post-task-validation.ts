#!/usr/bin/env bun
/**
 * Stop hook: refuse to call a task done on a red pipeline.
 *
 * Wired to `Stop` in `.claude/settings.json`. Exit code 2 is what Claude Code
 * treats as blocking — stderr is fed back to the agent, which then has to fix
 * the failure instead of reporting success.
 *
 * ## Why it short-circuits
 *
 * The full suite takes ~25 seconds. Running it at the end of every turn,
 * including turns that only answered a question, would make the tool unusable.
 * So the first thing this does is ask git whether any source file actually
 * changed; on a read-only turn it exits in milliseconds.
 *
 * ## Why the audit does not block
 *
 * `bun audit` needs the network. A failure there is usually a flaky connection,
 * not a vulnerability, and a blocking hook that cannot pass offline traps the
 * agent in a loop it has no way out of. Its result is reported, not enforced.
 * `lefthook`'s pre-push job is the real gate for that one.
 */
async function run(argv: string[]): Promise<{
  exitCode: number;
  stderr: string;
  stdout: string;
}> {
  const proc = Bun.spawn(argv, {
    cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stderr, stdout };
}

/** Extensions worth re-validating. A README edit does not need the suite. */
const SOURCE = /\.(?:tsx?|jsx?|jsonc?|css|cql|lua)$/;

/**
 * Commands as argv, not as strings passed to a shell.
 *
 * `sh -c` would work on macOS and Linux and fail on Windows, which is where
 * this project is actually developed. Spawning `bun` directly needs no shell on
 * any platform.
 */
interface Step {
  argv: string[];
  blocking: boolean;
  name: string;
}

const STEPS: Step[] = [
  { argv: ["bun", "run", "lint"], blocking: true, name: "lint" },
  { argv: ["bun", "run", "check-types"], blocking: true, name: "check-types" },
  { argv: ["bun", "run", "test"], blocking: true, name: "test" },
  // Reported, never enforced -- see the note above.
  { argv: ["bun", "run", "security:check"], blocking: false, name: "security" },
];

const changed = await run(["git", "status", "--porcelain"]);
const files = changed.stdout
  .split("\n")
  .map((line) => line.slice(3).trim())
  .filter((line) => line.length > 0 && SOURCE.test(line));

if (files.length === 0) {
  process.exit(0);
}

const failures: string[] = [];
const warnings: string[] = [];

for (const step of STEPS) {
  const result = await run(step.argv);

  if (result.exitCode === 0) {
    continue;
  }

  // Tail only: turbo's full output is thousands of lines, and the useful part
  // -- the actual error -- is at the end.
  const tail = [result.stderr, result.stdout]
    .join("\n")
    .trim()
    .split("\n")
    .slice(-25)
    .join("\n");

  const report = `${step.name} failed (${step.argv.join(" ")})\n${tail}`;
  if (step.blocking) {
    failures.push(report);
  } else {
    warnings.push(report);
  }
}

if (warnings.length > 0) {
  process.stdout.write(`${warnings.join("\n\n")}\n`);
}

if (failures.length === 0) {
  process.exit(0);
}

process.stderr.write(
  [
    "The pipeline is red. Fix these before reporting the task complete:",
    "",
    failures.join("\n\n"),
    "",
    "`bun run lint:fix` handles most style and import failures.",
  ].join("\n")
);

// 2 is the blocking code: Claude Code feeds stderr back rather than stopping.
process.exit(2);
