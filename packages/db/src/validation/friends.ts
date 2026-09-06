import { type Static, Type } from "@sinclair/typebox";
import { createInsertSchema, createSelectSchema } from "drizzle-typebox";
import { friends } from "../schema/friends";

export const selectFriendSchema = createSelectSchema(friends);
export type Friend = Static<typeof selectFriendSchema>;

export const insertFriendSchema = createInsertSchema(friends);
export type InsertFriend = Static<typeof insertFriendSchema>;

/**
 * What a client may send: the other user, and nothing else.
 *
 * The pair columns are absent on purpose. They are derived by `canonicalPair`
 * on the server, and the check constraint requires `userId1 < userId2` -- a
 * client that supplied them in the wrong order would get a constraint
 * violation, and one that supplied them in the right order could forge a
 * friendship between two other people. `requesterId` comes from the session
 * for the same reason.
 */
export const createFriendRequestDto = Type.Object({
  targetUserId: Type.String({
    description: "The user to send the request to.",
    format: "uuid",
  }),
});
export type CreateFriendRequestDto = Static<typeof createFriendRequestDto>;

/** Accepting or blocking. Going back to `pending` is not a transition. */
export const updateFriendStatusDto = Type.Object({
  status: Type.Union([Type.Literal("accepted"), Type.Literal("blocked")], {
    description: "The new state of the edge.",
  }),
});
export type UpdateFriendStatusDto = Static<typeof updateFriendStatusDto>;
