import { type Static, Type } from "@sinclair/typebox";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-typebox";
import { guildMembers } from "../schema/guild-members";
import { guilds } from "../schema/guilds";
import { invites } from "../schema/invites";

const guildName = Type.String({
  description: "Display name of the server.",
  maxLength: 100,
  minLength: 2,
});

export const selectGuildSchema = createSelectSchema(guilds, {
  name: guildName,
});
export type Guild = Static<typeof selectGuildSchema>;

export const insertGuildSchema = createInsertSchema(guilds, {
  name: guildName,
});
export type InsertGuild = Static<typeof insertGuildSchema>;

export const updateGuildSchema = createUpdateSchema(guilds, {
  name: Type.Optional(guildName),
});
export type UpdateGuild = Static<typeof updateGuildSchema>;

/**
 * `ownerId` is omitted: it comes from the session. Accepting it would let a
 * client create a server owned by someone else.
 */
export const createGuildDto = Type.Omit(insertGuildSchema, [
  "id",
  "createdAt",
  "ownerId",
]);
export type CreateGuildDto = Static<typeof createGuildDto>;

/**
 * Ownership transfer is deliberately not here. It is a separate, audited
 * operation -- the guilds table uses `onDelete: "restrict"` on `ownerId`
 * precisely so an owner cannot disappear silently.
 */
export const updateGuildDto = Type.Partial(
  Type.Omit(updateGuildSchema, ["id", "createdAt", "ownerId"])
);
export type UpdateGuildDto = Static<typeof updateGuildDto>;

export const selectGuildMemberSchema = createSelectSchema(guildMembers);
export type GuildMember = Static<typeof selectGuildMemberSchema>;

export const updateMemberDto = Type.Object({
  nickname: Type.Union([Type.String({ maxLength: 32 }), Type.Null()], {
    description: "Per-guild display name, or null to fall back to the profile.",
  }),
});
export type UpdateMemberDto = Static<typeof updateMemberDto>;

export const selectInviteSchema = createSelectSchema(invites);
export type Invite = Static<typeof selectInviteSchema>;

/**
 * `code` and `uses` are absent: the code is minted server-side, and `uses` is a
 * counter the server increments. A client-supplied code lets someone squat a
 * memorable one; a client-supplied counter lets them reset it.
 */
export const createInviteDto = Type.Object({
  expiresAt: Type.Optional(
    Type.Union([Type.String({ format: "date-time" }), Type.Null()], {
      description: "Null means the invite never expires.",
    })
  ),
  maxUses: Type.Optional(
    Type.Union([Type.Integer({ maximum: 100, minimum: 1 }), Type.Null()], {
      description: "Null means unlimited.",
    })
  ),
});
export type CreateInviteDto = Static<typeof createInviteDto>;
