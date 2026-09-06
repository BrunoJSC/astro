import { type Static, Type } from "@sinclair/typebox";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-typebox";
import { verification } from "../schema/verifications";

export const selectVerificationSchema = createSelectSchema(verification);
export type Verification = Static<typeof selectVerificationSchema>;

export const insertVerificationSchema = createInsertSchema(verification, {
  identifier: Type.String({
    description: "Subject being verified -- usually the email address.",
    minLength: 1,
  }),
  value: Type.String({
    description:
      "One-time token. Treat as a secret; never return it in a response.",
    minLength: 1,
  }),
});
export type InsertVerification = Static<typeof insertVerificationSchema>;

export const updateVerificationSchema = createUpdateSchema(verification);
export type UpdateVerification = Static<typeof updateVerificationSchema>;
