import { type Static, Type } from "@sinclair/typebox";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-typebox";
import { session } from "../schema/sessions";

const tokenColumn = Type.String({
  description: "Opaque session token presented by the client. Never logged.",
  minLength: 1,
});

const userAgentColumn = Type.Union(
  [Type.String({ maxLength: 512 }), Type.Null()],
  { description: "Client user agent, as reported at sign-in." }
);

export const selectSessionSchema = createSelectSchema(session, {
  token: tokenColumn,
  userAgent: userAgentColumn,
});
export type Session = Static<typeof selectSessionSchema>;

// See users.ts: refining a nullable column drops its optional modifier, so
// `Type.Optional` has to be restored on insert.
export const insertSessionSchema = createInsertSchema(session, {
  token: tokenColumn,
  userAgent: Type.Optional(userAgentColumn),
});
export type InsertSession = Static<typeof insertSessionSchema>;

export const updateSessionSchema = createUpdateSchema(session, {
  token: Type.Optional(tokenColumn),
  userAgent: Type.Optional(userAgentColumn),
});
export type UpdateSession = Static<typeof updateSessionSchema>;

/**
 * No `createSessionDto` on purpose: sessions are minted by Better Auth, never
 * from a client payload. A DTO would invite exactly the endpoint that must not
 * exist. `userId` is omitted from the update for the same reason -- reassigning
 * a session to another user is account takeover.
 */
export const updateSessionDto = Type.Partial(
  Type.Omit(updateSessionSchema, ["id", "createdAt", "updatedAt", "userId"])
);
export type UpdateSessionDto = Static<typeof updateSessionDto>;
