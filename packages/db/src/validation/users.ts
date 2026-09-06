import { type Static, Type } from "@sinclair/typebox";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-typebox";
import { user } from "../schema/users";

/**
 * Derived from the Drizzle table, never written by hand: a column added or a
 * nullability changed in `../schema/users.ts` propagates here on the next
 * type-check instead of drifting silently.
 *
 * Built with `@sinclair/typebox`'s `Type`, which resolves to the same 0.34.x
 * instance Elysia bundles -- so these drop straight into an Elysia route's
 * `body` / `response` and feed both its runtime validation and the OpenAPI
 * document. Use `createSchemaFactory({ typeboxInstance: t })` from the barrel
 * if you ever need an Elysia-specific format.
 */
const emailColumn = Type.String({
  description: "Unique login address. Lower-cased by Better Auth.",
  format: "email",
  maxLength: 254,
});

const nameColumn = Type.String({
  description: "Display name.",
  maxLength: 255,
  minLength: 1,
});

const imageColumn = Type.Union([Type.String({ format: "uri" }), Type.Null()], {
  description: "Avatar URL, or null when the provider supplied none.",
});

/*
 * Mirrors the `username()` plugin's configuration in @repo/auth. The bounds are
 * duplicated on purpose: the plugin enforces them on its own endpoints, while
 * these schemas guard any write that reaches the table another way. Keep the
 * two in step -- a mismatch shows up as a row the API can create but the DTO
 * rejects.
 *
 * Lower-case only, because the plugin normalizes `username` before validating.
 * `displayUsername` keeps the casing the user typed, which is its whole point.
 */
const usernameColumn = Type.Union(
  [
    Type.String({ maxLength: 30, minLength: 3, pattern: "^[a-z0-9_]+$" }),
    Type.Null(),
  ],
  {
    description:
      "Case-insensitive login handle, normalized to lower case. Null until the user picks one.",
  }
);

const displayUsernameColumn = Type.Union(
  [
    Type.String({ maxLength: 30, minLength: 3, pattern: "^[a-zA-Z0-9_]+$" }),
    Type.Null(),
  ],
  {
    description:
      "The username as typed, preserving case. Never used to log in.",
  }
);

export const selectUserSchema = createSelectSchema(user, {
  displayUsername: displayUsernameColumn,
  email: emailColumn,
  // Required but nullable: a row always carries the column, whatever its value.
  image: imageColumn,
  name: nameColumn,
  username: usernameColumn,
});
export type User = Static<typeof selectUserSchema>;

/**
 * A refinement REPLACES the generated column schema, including its optional
 * modifier -- so a nullable column refined without `Type.Optional` becomes a
 * required key that merely accepts null. Insert schemas therefore wrap the
 * nullable ones explicitly.
 */
export const insertUserSchema = createInsertSchema(user, {
  displayUsername: Type.Optional(displayUsernameColumn),
  email: emailColumn,
  image: Type.Optional(imageColumn),
  name: nameColumn,
  username: Type.Optional(usernameColumn),
});
export type InsertUser = Static<typeof insertUserSchema>;

export const updateUserSchema = createUpdateSchema(user, {
  displayUsername: Type.Optional(displayUsernameColumn),
  email: Type.Optional(emailColumn),
  image: Type.Optional(imageColumn),
  name: Type.Optional(nameColumn),
  username: Type.Optional(usernameColumn),
});
export type UpdateUser = Static<typeof updateUserSchema>;

/**
 * Request payloads. `id` comes from `newId` and both timestamps from the
 * database, so accepting them from a client would let it forge either.
 */
export const createUserDto = Type.Omit(insertUserSchema, [
  "id",
  "createdAt",
  "updatedAt",
]);
export type CreateUserDto = Static<typeof createUserDto>;

// `createUpdateSchema` already makes every field optional; `Type.Partial` is
// idempotent here and kept so the intent survives a change upstream.
export const updateUserDto = Type.Partial(
  Type.Omit(updateUserSchema, ["id", "createdAt", "updatedAt"])
);
export type UpdateUserDto = Static<typeof updateUserDto>;
