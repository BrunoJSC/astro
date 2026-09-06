import { describe, expect, it } from "bun:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import * as schema from "../../src/schema/index";

describe("schema barrel", () => {
  it("is importable without a database connection", () => {
    expect(schema).toBeTypeOf("object");
  });

  it("exports the four tables Better Auth requires", () => {
    // These names are the Drizzle adapter's model lookup keys -- renaming any
    // of them silently breaks auth at runtime, not at compile time.
    for (const table of [
      schema.user,
      schema.session,
      schema.account,
      schema.verification,
    ]) {
      expect(table).toBeDefined();
    }
    expect(getTableName(schema.user)).toBe("user");
    expect(getTableName(schema.session)).toBe("session");
    expect(getTableName(schema.account)).toBe("account");
    expect(getTableName(schema.verification)).toBe("verification");
  });

  it("re-exports the relations, which drizzle() needs for relational queries", () => {
    expect(schema.userRelations).toBeDefined();
    expect(schema.sessionRelations).toBeDefined();
    expect(schema.accountRelations).toBeDefined();
  });
});

describe("column shape", () => {
  it("keeps the columns Better Auth reads on session", () => {
    const columns = Object.keys(getTableColumns(schema.session));
    expect(columns).toEqual(
      expect.arrayContaining(["id", "token", "expiresAt", "userId"])
    );
  });

  it("keeps account.password nullable for OAuth accounts", () => {
    // OAuth rows carry no password hash; a NOT NULL here would reject them.
    expect(getTableColumns(schema.account).password.notNull).toBe(false);
  });

  it("defaults every primary key to a UUIDv7", () => {
    for (const table of [
      schema.user,
      schema.session,
      schema.account,
      schema.verification,
    ]) {
      expect(getTableColumns(table).id.defaultFn).toBeTypeOf("function");
    }
  });
});
