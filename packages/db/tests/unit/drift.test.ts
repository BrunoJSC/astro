import { describe, expect, it } from "bun:test";
import { getTableColumns, getTableName, type Table } from "drizzle-orm";
import * as generated from "../../src/schema/generated/better-auth";
import * as ours from "../../src/schema/index";

/**
 * Contract check against the Better Auth CLI's output.
 *
 * `bun run auth:generate` writes `./generated/better-auth.ts` verbatim; the
 * tables beside this file are the source of truth and intentionally differ.
 * These tests compare only what Better Auth actually depends on -- table and
 * column names, nullability, and the broad column type -- so the deliberate
 * divergences pass untouched:
 *
 *   - `timestamptz` vs `timestamp`: both report columnType "PgTimestamp", so
 *     the timezone flag is invisible here. That is the point.
 *   - `$defaultFn(newId)`: an extra default is fine; a MISSING one is not, so
 *     the check is one-directional.
 *   - composite indexes: not compared at all. Adding an index cannot break a
 *     reader.
 *
 * What it does catch is the dangerous class: a Better Auth upgrade that adds a
 * column, renames one, or changes its nullability. Those break auth at runtime
 * and are invisible to `check-types`, because the adapter looks models up by
 * string.
 */
interface ColumnFacts {
  columnType: string;
  dataType: string;
  name: string;
  notNull: boolean;
  primary: boolean;
}

const facts = (table: Table): Record<string, ColumnFacts> =>
  Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => [
      key,
      {
        columnType: column.columnType,
        dataType: column.dataType,
        name: column.name,
        notNull: column.notNull,
        primary: column.primary,
      },
    ])
  );

/**
 * Columns our schema has that the generator does not emit.
 *
 * Listed explicitly so the check stays one-directional: a column WE add is
 * fine, a column BETTER AUTH adds still fails. Anything here needs the same
 * justification as a schema change, because it will not be revisited by the
 * generator.
 */
const INTENTIONAL_EXTRA_COLUMNS: Record<string, readonly string[]> = {
  // better-auth 1.7 scopes account identity by `issuer` and the runtime adapter
  // refuses to write without the column, but its CLI does not generate it --
  // generator and runtime disagree. Remove once the generator emits it.
  account: ["issuer"],
};

const PAIRS: [string, Table, Table][] = [
  ["user", ours.user, generated.user],
  ["session", ours.session, generated.session],
  ["account", ours.account, generated.account],
  ["verification", ours.verification, generated.verification],
];

describe("schema matches what Better Auth expects", () => {
  it("declares every table the generator emits", () => {
    // The module also exports the relations objects; getTableName throws on
    // those, so they are filtered by name rather than by a type predicate --
    // the union of tables and relations is not narrowable to Table.
    const generatedTables = Object.entries(generated)
      .filter(([key]) => !key.endsWith("Relations"))
      .map(([, value]) => getTableName(value as Table))
      .sort();
    const ourTables = PAIRS.map(([, table]) => getTableName(table)).sort();
    expect(ourTables).toEqual(expect.arrayContaining(generatedTables));
  });

  for (const [label, mine, expected] of PAIRS) {
    describe(label, () => {
      it("keeps the same SQL table name", () => {
        expect(getTableName(mine)).toBe(getTableName(expected));
      });

      it("declares every column the generator emits", () => {
        expect(Object.keys(facts(mine)).sort()).toEqual(
          expect.arrayContaining(Object.keys(facts(expected)).sort())
        );
      });

      it("adds no column beyond the documented exceptions", () => {
        const extras = Object.keys(facts(mine)).filter(
          (key) => !(key in facts(expected))
        );
        expect(extras.sort()).toEqual(
          [...(INTENTIONAL_EXTRA_COLUMNS[label] ?? [])].sort()
        );
      });

      it("matches on name, nullability and type for every generated column", () => {
        const ourColumns = facts(mine);
        for (const [key, generatedColumn] of Object.entries(facts(expected))) {
          expect(ourColumns[key]).toEqual(generatedColumn);
        }
      });

      it("keeps every default the generator declares", () => {
        // One-directional: our `$defaultFn(newId)` adds defaults the generator
        // has none of, which is intended. Losing one it does declare is not.
        const mineColumns = getTableColumns(mine);
        for (const [key, column] of Object.entries(getTableColumns(expected))) {
          if (column.hasDefault) {
            expect(mineColumns[key]?.hasDefault).toBe(true);
          }
        }
      });
    });
  }
});
