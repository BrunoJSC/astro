import argon2 from "argon2";
import { describe, expect, it } from "vitest";
import { ARGON2_OPTIONS, auth } from "../../src/server";

const PASSWORD = "correct horse battery staple";
const hash = (password: string) => argon2.hash(password, ARGON2_OPTIONS);

describe("argon2id password hashing", () => {
  it("encodes the algorithm and parameters into the hash", async () => {
    const { memoryCost, parallelism, timeCost } = ARGON2_OPTIONS;
    const encoded = await hash(PASSWORD);
    expect(encoded.startsWith("$argon2id$")).toBe(true);
    // node-argon2 emits the parameters alphabetically (m, p, t), not in the
    // m, t, p order the PHC string spec shows.
    expect(encoded).toContain(`m=${memoryCost},p=${parallelism},t=${timeCost}`);
  });

  it("verifies the correct password and rejects a wrong one", async () => {
    const encoded = await hash(PASSWORD);
    expect(await argon2.verify(encoded, PASSWORD)).toBe(true);
    expect(await argon2.verify(encoded, "wrong")).toBe(false);
  });

  it("salts each hash independently", async () => {
    const [a, b] = await Promise.all([hash(PASSWORD), hash(PASSWORD)]);
    expect(a).not.toBe(b);
    expect(await argon2.verify(a, PASSWORD)).toBe(true);
    expect(await argon2.verify(b, PASSWORD)).toBe(true);
  });
});

describe("better-auth wiring", () => {
  it("uses the argon2 hasher configured on the instance", async () => {
    const hasher = auth.options.emailAndPassword?.password;
    expect(hasher).toBeDefined();

    const encoded = await hasher?.hash(PASSWORD);
    expect(encoded?.startsWith("$argon2id$")).toBe(true);
    expect(
      await hasher?.verify({ hash: encoded ?? "", password: PASSWORD })
    ).toBe(true);
  });

  it("folds a malformed stored hash into a failed login", async () => {
    const hasher = auth.options.emailAndPassword?.password;
    const malformed = ["", "not-a-hash", "$argon2id$bad"];
    const results = await Promise.all(
      malformed.map((value) =>
        hasher?.verify({ hash: value, password: PASSWORD })
      )
    );
    expect(results).toEqual(malformed.map(() => false));
  });
});
