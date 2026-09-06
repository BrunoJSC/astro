import { describe, expect, it } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import {
  createUserDto,
  insertAccountSchema,
  insertUserSchema,
  selectUserSchema,
  updateUserDto,
} from "../../src/validation/index";

const now = new Date();
const fullUser = {
  avatarUrl: null,
  bannerUrl: null,
  createdAt: now,
  displayUsername: "Ana_Silva",
  email: "ana@example.com",
  emailVerified: false,
  id: "01a00000-0000-7000-8000-000000000001",
  image: null,
  name: "Ana",
  updatedAt: now,
  username: "ana_silva",
};

describe("select schema", () => {
  it("accepts a full row", () => {
    expect(Value.Check(selectUserSchema, fullUser)).toBe(true);
  });

  it("rejects a wrong column type", () => {
    expect(
      Value.Check(selectUserSchema, { ...fullUser, emailVerified: "no" })
    ).toBe(false);
  });

  it("requires every column -- a row always carries them all", () => {
    expect(
      Value.Check(selectUserSchema, { email: "a@b.co", name: "Ana" })
    ).toBe(false);
  });
});

describe("insert schema", () => {
  it("makes defaulted columns optional", () => {
    expect(
      Value.Check(insertUserSchema, { email: "a@b.co", name: "Ana" })
    ).toBe(true);
  });

  it("keeps refined nullable columns OPTIONAL, not merely nullable", () => {
    /*
     * Regression guard. A refinement replaces the generated column schema
     * including its optional modifier, so `image: Type.Union([String, Null])`
     * silently turns into a REQUIRED key that happens to accept null. The
     * refinements wrap nullable columns in `Type.Optional` to prevent that;
     * this asserts the wrapper is still there.
     */
    expect(insertUserSchema.required ?? []).not.toContain("image");
    expect(insertAccountSchema.required ?? []).not.toContain("password");
    expect(insertAccountSchema.required ?? []).not.toContain("scope");
  });

  it("still accepts an explicit null for those columns", () => {
    expect(
      Value.Check(insertUserSchema, {
        email: "a@b.co",
        image: null,
        name: "Ana",
      })
    ).toBe(true);
  });
});

describe("DTOs", () => {
  it("drops the database-managed columns from the create payload", () => {
    for (const key of ["id", "createdAt", "updatedAt"]) {
      expect(createUserDto.properties).not.toHaveProperty(key);
    }
    expect(createUserDto.properties).toHaveProperty("email");
  });

  it("makes every updatable field optional", () => {
    expect(Value.Check(updateUserDto, {})).toBe(true);
    expect(Value.Check(updateUserDto, { name: "Ana" })).toBe(true);
  });

  it("still rejects a wrong type on an optional field", () => {
    expect(Value.Check(updateUserDto, { name: 42 })).toBe(false);
  });
});

describe("format annotations", () => {
  /*
   * TypeBox 0.34 fails validation on an UNREGISTERED format rather than
   * ignoring it, so `format: "email"` would reject every value -- valid ones
   * included -- outside Elysia. `./formats` registers them at import time;
   * these two assertions are what prove that side effect still runs.
   */
  it("enforces the email format", () => {
    expect(
      Value.Check(createUserDto, { email: "ana@example.com", name: "Ana" })
    ).toBe(true);
    expect(
      Value.Check(createUserDto, { email: "not-an-email", name: "Ana" })
    ).toBe(false);
  });

  it("enforces the uri format on image", () => {
    const base = { email: "a@b.co", name: "Ana" };
    expect(
      Value.Check(createUserDto, { ...base, image: "https://x.co/a.png" })
    ).toBe(true);
    expect(Value.Check(createUserDto, { ...base, image: "not a url" })).toBe(
      false
    );
  });
});

describe("account secrets", () => {
  it("types password as a nullable hash, with no plaintext length rule", () => {
    // Checked structurally, not by string search: the column's own
    // description mentions the word "minLength".
    const branches = insertAccountSchema.properties.password.anyOf ?? [];
    expect(branches.some((b: { type?: string }) => b.type === "null")).toBe(
      true
    );
    for (const branch of branches) {
      expect(branch).not.toHaveProperty("minLength");
    }
  });

  it("accepts an OAuth account with no password", () => {
    expect(
      Value.Check(insertAccountSchema, {
        accountId: "acc_1",
        // uuid format is registered, so these have to be real uuids now.
        id: "01a00000-0000-7000-8000-000000000001",
        issuer: "oauth:github",
        providerId: "github",
        userId: "01a00000-0000-7000-8000-000000000002",
      })
    ).toBe(true);
  });
});

describe("username columns", () => {
  it("accepts a lower-case handle within the plugin's bounds", () => {
    expect(
      Value.Check(createUserDto, {
        email: "a@b.co",
        name: "Ada",
        username: "ada_lovelace",
      })
    ).toBe(true);
  });

  it("rejects a handle with a dot", () => {
    // Must stay unconfusable with an email and with a URL path segment.
    expect(
      Value.Check(createUserDto, {
        email: "a@b.co",
        name: "Ada",
        username: "ada.lovelace",
      })
    ).toBe(false);
  });

  it("enforces the same length bounds as the plugin", () => {
    const base = { email: "a@b.co", name: "Ada" };
    expect(Value.Check(createUserDto, { ...base, username: "ab" })).toBe(false);
    expect(
      Value.Check(createUserDto, { ...base, username: "a".repeat(31) })
    ).toBe(false);
    expect(Value.Check(createUserDto, { ...base, username: "abc" })).toBe(true);
  });

  it("keeps username optional and nullable", () => {
    // A user exists before picking a handle.
    const base = { email: "a@b.co", name: "Ada" };
    expect(Value.Check(createUserDto, base)).toBe(true);
    expect(Value.Check(createUserDto, { ...base, username: null })).toBe(true);
  });

  it("allows mixed case in displayUsername only", () => {
    const base = { email: "a@b.co", name: "Ada" };
    expect(
      Value.Check(createUserDto, { ...base, displayUsername: "Ada_Lovelace" })
    ).toBe(true);
    expect(
      Value.Check(createUserDto, { ...base, username: "Ada_Lovelace" })
    ).toBe(false);
  });
});
