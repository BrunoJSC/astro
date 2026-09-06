/**
 * `bun run auth:generate`
 *
 * Runs the Better Auth CLI, then rewrites `@repo/db`'s schema files from its
 * output. The CLI alone is not enough: it emits one flat file of plain
 * `timestamp()` columns with no composite indexes, and it has no option for
 * any of that -- there is no `withTimezone` setting anywhere in
 * `@better-auth/cli`. Running it directly against the schema would silently
 * revert four deliberate decisions.
 *
 * So the CLI output is treated as input. This script owns the schema files:
 * it applies the transforms below and splits the result per table, which makes
 * regeneration idempotent -- run it twice and the second run changes nothing.
 *
 * Transforms:
 *   1. `timestamp(x)`            -> `timestamp(x, { withTimezone: true })`
 *   2. `text("id").primaryKey()` -> `.$defaultFn(newId)` appended
 *   3. composite indexes appended per table
 *   4. one file per table, plus relations
 *
 * Edit THIS FILE, not the generated schema files.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { $ } from "bun";

const TIMESTAMP_PATTERN = /timestamp\("([a-z_]+)"\)/g;
const PRIMARY_KEY_PATTERN = /text\("id"\)\.primaryKey\(\)/g;
const USER_REFERENCE_PATTERN = /references\(\(\) => user\./;
const USER_FK_PATTERN = /text\("user_id"\)/g;
const TRAILING_COMMA_PATTERN = /,$/;

const AUTH_ROOT = join(import.meta.dir, "..");
const DB_SCHEMA = join(AUTH_ROOT, "../db/src/schema");
const REFERENCE = join(DB_SCHEMA, "generated/better-auth.ts");
/*
 * The CLI resolves --output against its cwd even when handed an absolute path,
 * so passing REFERENCE directly wrote the file to
 * `packages/auth/Users/macos/.../better-auth.ts` -- a duplicated directory tree
 * that was committed before anyone noticed. Give it a path relative to
 * AUTH_ROOT instead.
 */
const REFERENCE_RELATIVE = "../db/src/schema/generated/better-auth.ts";

/** Per-table output: file name, prose, and the indexes the CLI does not emit. */
const TABLES = {
  account: {
    doc: `Credentials and linked providers, one row per (providerId, accountId).

\`password\` holds the Argon2id hash for email/password sign-in -- the column is
nullable because OAuth accounts have none. The OAuth token columns are the
mirror case: null for password accounts.`,
    /*
     * Better Auth 1.7 scopes account identity by `issuer`, and the runtime
     * adapter refuses to write an account without the column ("The field
     * \"issuer\" does not exist in the \"account\" Drizzle schema") -- which
     * breaks sign-up entirely. Its own CLI does not emit the column, so the
     * drift test cannot catch the gap: generator and runtime disagree. Added
     * here until the generator catches up.
     */
    extraColumns: ['issuer: text("issuer"),'],
    extraIndexes: [
      `/*
     * The OAuth sign-in lookup: Better Auth resolves an account by
     * (providerId, accountId) on every callback. Leading with providerId makes
     * the index usable for "all accounts of this provider" too, which the
     * reverse order would not.
     */
    index("account_provider_account_idx").on(table.providerId, table.accountId)`,
    ],
    file: "accounts.ts",
  },
  session: {
    doc: `Active sessions. \`token\` is what the client presents; it is unique and
indexed by that constraint, and \`user_id\` carries its own index because every
session lookup filters on it.

\`onDelete: "cascade"\` is load-bearing: deleting a user must not strand sessions
that would otherwise still authenticate.`,
    extraColumns: [],
    extraIndexes: [],
    file: "sessions.ts",
  },
  user: {
    doc: `The account owner. The export is named \`user\`, singular, because that is the
model name Better Auth's Drizzle adapter looks up -- renaming it to \`users\`
would require an explicit mapping in \`drizzleAdapter\`.`,
    /*
     * Better Auth writes `image` from the OAuth provider. These two are the
     * user's own uploads and take precedence -- read `avatarUrl ?? image`.
     * Keeping them apart means re-linking a provider cannot silently overwrite
     * an avatar the user chose.
     */
    extraColumns: [
      'avatarUrl: text("avatar_url"),',
      'bannerUrl: text("banner_url"),',
    ],
    extraIndexes: [],
    file: "users.ts",
  },
  verification: {
    doc: `Short-lived tokens for email verification, password reset and magic links.

Nothing references this table, so it has no foreign key -- expired rows are safe
to prune on a schedule.`,
    extraColumns: [],
    extraIndexes: [
      `/*
     * Consuming a token matches identifier AND value together. The single
     * identifier index above still serves the cleanup query that prunes every
     * token for an address.
     */
    index("verification_identifier_value_idx").on(table.identifier, table.value)`,
    ],
    file: "verifications.ts",
  },
} as const;

type TableName = keyof typeof TABLES;

/** Extracts `export const <name> = <callee>(...);` by matching parentheses. */
function extractBlock(source: string, name: string): string {
  const start = source.indexOf(`export const ${name} = `);
  if (start === -1) {
    throw new Error(`Generated file has no export named "${name}"`);
  }

  let depth = 0;
  let seenOpen = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === "(") {
      depth += 1;
      seenOpen = true;
    } else if (char === ")") {
      depth -= 1;
      if (seenOpen && depth === 0) {
        // Include the trailing semicolon.
        return source.slice(start, source.indexOf(";", i) + 1);
      }
    }
  }

  throw new Error(`Unbalanced parentheses while extracting "${name}"`);
}

/** Every `timestamp("x")` becomes timezone-aware. */
function withTimezone(block: string): string {
  return block.replace(
    TIMESTAMP_PATTERN,
    'timestamp("$1", { withTimezone: true })'
  );
}

/**
 * Native `uuid` primary keys with a UUIDv7 default.
 *
 * The CLI emits `text("id")`, which stores a 36-character string: 37 bytes
 * against 16 for a native uuid, 2.3x, on every primary key and every foreign
 * key that points at one. Postgres also compares uuid as a 128-bit value
 * rather than through text collation.
 *
 * UUIDv7 rather than `defaultRandom()` (which is v4): the timestamp prefix
 * makes ids sort chronologically, so inserts append to the right-hand edge of
 * the B-tree instead of scattering across it. Random uuids fragment the index
 * and turn every insert into a page split somewhere unpredictable.
 *
 * The default is set on BOTH sides -- see `defaultUuidV7` in ../db/src/id.ts.
 */
function withGeneratedId(block: string): string {
  return block.replace(
    PRIMARY_KEY_PATTERN,
    'uuid("id").primaryKey().$defaultFn(newId).default(sql`uuidv7()`)'
  );
}

/** Foreign keys to user.id have to carry the same type as the column they reference. */
function withUuidForeignKeys(block: string): string {
  return block.replace(USER_FK_PATTERN, 'uuid("user_id")');
}

/** Inserts extra columns at the head of the table's column object. */
function withExtraColumns(block: string, columns: readonly string[]): string {
  if (columns.length === 0) {
    return block;
  }

  // The first `{` after the table-name string opens the column object.
  const brace = block.indexOf("{", block.indexOf('"'));
  if (brace === -1) {
    throw new Error("Expected a column object to insert into");
  }

  const addition = columns.map((column) => `\n    ${column}`).join("");
  return block.slice(0, brace + 1) + addition + block.slice(brace + 1);
}

/** Appends composite indexes to the table's index array, or creates one. */
function withExtraIndexes(block: string, indexes: readonly string[]): string {
  if (indexes.length === 0) {
    return block;
  }

  const addition = indexes.map((index) => `    ${index},`).join("\n");
  const closing = block.lastIndexOf("]");
  if (closing === -1) {
    throw new Error("Expected an index array to append to");
  }

  const head = block
    .slice(0, closing)
    .trimEnd()
    .replace(TRAILING_COMMA_PATTERN, "");
  return `${head},\n${addition}\n  ${block.slice(closing)}`;
}

function importsFor(block: string, needsNewId: boolean): string {
  const pgCore = [
    "boolean",
    "index",
    "pgTable",
    "text",
    "timestamp",
    "uuid",
  ].filter((symbol) => new RegExp(`\\b${symbol}\\(`).test(block));

  const lines = [`import { ${pgCore.join(", ")} } from "drizzle-orm/pg-core";`];
  if (needsNewId) {
    lines.push('import { sql } from "drizzle-orm";');
    lines.push('import { newId } from "../id";');
  }
  if (USER_REFERENCE_PATTERN.test(block)) {
    lines.push('import { user } from "./users";');
  }
  return lines.sort().join("\n");
}

function docBlock(text: string): string {
  const body = text
    .split("\n")
    .map((line) => (line ? ` * ${line}` : " *"))
    .join("\n");
  return `/**\n${body}\n */`;
}

async function main(): Promise<void> {
  await mkdir(dirname(REFERENCE), { recursive: true });

  /*
   * Step 1: the CLI writes its verbatim output to the reference file, which is
   * versioned so that a Better Auth upgrade produces a reviewable diff.
   *
   * The unlink is load-bearing. Pointed at an existing file the CLI reports
   * "Schema was overwritten successfully!" but leaves new columns out -- adding
   * the username plugin produced no diff at all until the file was removed
   * first. Regenerating into a fresh path is the only way to be sure the output
   * reflects the current config.
   */
  await rm(REFERENCE, { force: true });
  await $`bunx @better-auth/cli generate --config ./src/server.ts --output ${REFERENCE_RELATIVE} --yes`.cwd(
    AUTH_ROOT
  );

  // The CLI reports success even when it writes nowhere useful, so confirm.
  // `existsSync`, not `Bun.file`: Biome does not know the Bun global.
  if (!existsSync(REFERENCE)) {
    throw new Error(`The CLI did not write ${REFERENCE}`);
  }

  const generated = await readFile(REFERENCE, "utf8");
  const written: string[] = [];
  const pending: Promise<void>[] = [];

  // Step 2: one file per table, transforms applied.
  for (const [name, config] of Object.entries(TABLES) as [
    TableName,
    (typeof TABLES)[TableName],
  ][]) {
    let block = extractBlock(generated, name);
    block = withTimezone(block);
    block = withGeneratedId(block);
    block = withUuidForeignKeys(block);
    block = withExtraColumns(block, config.extraColumns);
    block = withExtraIndexes(block, config.extraIndexes);

    const banner =
      "// Generated by packages/auth/scripts/generate-schema.ts -- do not edit.\n// Run `bun run auth:generate` in @repo/auth after changing the auth config.";
    const file = [
      banner,
      "",
      importsFor(block, block.includes("$defaultFn(newId)")),
      "",
      docBlock(config.doc),
      block,
      "",
    ].join("\n");

    pending.push(writeFile(join(DB_SCHEMA, config.file), file));
    written.push(config.file);
  }

  await Promise.all(pending);

  /*
   * Relations are NOT generated. Drizzle allows exactly one `relations()` call
   * per table, and the domain schema needs `userRelations` to also declare
   * guilds, memberships and friendships. A generated file cannot know about
   * those, so `relations.ts` is hand-owned and covers both halves. Relations
   * are derived from foreign keys and change far less often than columns do --
   * and the drift test still compares the tables themselves.
   */

  /*
   * Format as the final step. Without it `bun run lint:fix` would reformat
   * these files afterwards, and the next generation would emit the unformatted
   * version again -- an endless diff between the two commands. Formatting here
   * makes the output a fixed point of both.
   */
  await $`bunx biome check --write ${DB_SCHEMA}`.quiet().nothrow();

  process.stdout.write(`schema written: ${written.join(", ")}\n`);
}

await main();
