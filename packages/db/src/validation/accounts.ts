import { type Static, Type } from "@sinclair/typebox";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-typebox";
import { account } from "../schema/accounts";

const passwordColumn = Type.Union([Type.String(), Type.Null()], {
  description:
    "Argon2id hash ($argon2id$...), not a plaintext password. A minLength rule would be validating the wrong value -- the length here is fixed by the KDF, and the plaintext never reaches this column.",
});

const providerIdColumn = Type.String({
  description:
    'Provider key: "credential" for email/password, otherwise the OAuth provider id.',
  minLength: 1,
});

const scopeColumn = Type.Union([Type.String(), Type.Null()], {
  description: "Space-separated OAuth scopes granted, or null.",
});

export const selectAccountSchema = createSelectSchema(account, {
  password: passwordColumn,
  providerId: providerIdColumn,
  scope: scopeColumn,
});
export type Account = Static<typeof selectAccountSchema>;

export const insertAccountSchema = createInsertSchema(account, {
  password: Type.Optional(passwordColumn),
  providerId: providerIdColumn,
  scope: Type.Optional(scopeColumn),
});
export type InsertAccount = Static<typeof insertAccountSchema>;

export const updateAccountSchema = createUpdateSchema(account, {
  password: Type.Optional(passwordColumn),
  providerId: Type.Optional(providerIdColumn),
  scope: Type.Optional(scopeColumn),
});
export type UpdateAccount = Static<typeof updateAccountSchema>;

/**
 * Omits every secret-bearing column. These are written by Better Auth from the
 * OAuth exchange or the password hasher; a client-supplied `accessToken` or
 * `password` would be an account-takeover primitive.
 */
export const updateAccountDto = Type.Partial(
  Type.Omit(updateAccountSchema, [
    "id",
    "createdAt",
    "updatedAt",
    "userId",
    "password",
    "accessToken",
    "refreshToken",
    "idToken",
  ])
);
export type UpdateAccountDto = Static<typeof updateAccountDto>;
