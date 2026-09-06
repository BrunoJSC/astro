import { relations } from "drizzle-orm";
import { account } from "./accounts";
import { channelPermissionOverrides } from "./channel-overrides";
import { channels } from "./channels";
import { guildEmojis } from "./emojis";
import { friends } from "./friends";
import { guildMembers } from "./guild-members";
import { guilds } from "./guilds";
import { invites } from "./invites";
import { memberRoles } from "./member-roles";
import { channelReadState } from "./read-state";
import { roles } from "./roles";
import { session } from "./sessions";
import { user } from "./users";

/**
 * Hand-owned, and deliberately not part of `auth:generate`.
 *
 * Drizzle permits one `relations()` call per table, so `userRelations` has to
 * cover Better Auth's sessions and accounts AND the domain's guilds,
 * memberships and friendships in the same declaration. A generated file cannot
 * see the second half.
 *
 * These declarations are what `db.query.<table>.findMany({ with: ... })` reads;
 * they add no constraint to the database. The foreign keys in the table files
 * are what actually enforce integrity.
 */
export const userRelations = relations(user, ({ many }) => ({
  accounts: many(account),
  guildsOwned: many(guilds),
  invitesCreated: many(invites),
  memberships: many(guildMembers),
  readState: many(channelReadState),
  sessions: many(session),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

/**
 * Both sides of a friendship point at `user`, so each needs an explicit
 * `relationName` -- without it Drizzle cannot tell which of the two foreign
 * keys a given relation refers to, and the query builder picks arbitrarily.
 */
export const friendsRelations = relations(friends, ({ one }) => ({
  requester: one(user, {
    fields: [friends.requesterId],
    references: [user.id],
    relationName: "friend_requester",
  }),
  userOne: one(user, {
    fields: [friends.userId1],
    references: [user.id],
    relationName: "friend_user_one",
  }),
  userTwo: one(user, {
    fields: [friends.userId2],
    references: [user.id],
    relationName: "friend_user_two",
  }),
}));

export const guildsRelations = relations(guilds, ({ many, one }) => ({
  channels: many(channels),
  emojis: many(guildEmojis),
  invites: many(invites),
  members: many(guildMembers),
  owner: one(user, { fields: [guilds.ownerId], references: [user.id] }),
  roles: many(roles),
}));

export const guildMembersRelations = relations(
  guildMembers,
  ({ many, one }) => ({
    guild: one(guilds, {
      fields: [guildMembers.guildId],
      references: [guilds.id],
    }),
    roles: many(memberRoles),
    user: one(user, { fields: [guildMembers.userId], references: [user.id] }),
  })
);

export const invitesRelations = relations(invites, ({ one }) => ({
  guild: one(guilds, { fields: [invites.guildId], references: [guilds.id] }),
  inviter: one(user, { fields: [invites.inviterId], references: [user.id] }),
}));

export const rolesRelations = relations(roles, ({ many, one }) => ({
  guild: one(guilds, { fields: [roles.guildId], references: [guilds.id] }),
  members: many(memberRoles),
}));

export const memberRolesRelations = relations(memberRoles, ({ one }) => ({
  member: one(guildMembers, {
    fields: [memberRoles.guildId, memberRoles.userId],
    references: [guildMembers.guildId, guildMembers.userId],
  }),
  role: one(roles, { fields: [memberRoles.roleId], references: [roles.id] }),
}));

/**
 * `category` and `children` are the two directions of the same self-reference,
 * so they share a `relationName`. Drizzle pairs them by that name.
 */
export const channelsRelations = relations(channels, ({ many, one }) => ({
  category: one(channels, {
    fields: [channels.categoryId],
    references: [channels.id],
    relationName: "channel_category",
  }),
  children: many(channels, { relationName: "channel_category" }),
  guild: one(guilds, { fields: [channels.guildId], references: [guilds.id] }),
  overrides: many(channelPermissionOverrides),
  readState: many(channelReadState),
}));

/**
 * Only the channel side is declared. `targetId` is polymorphic -- a role id or
 * a user id -- and Drizzle relations require a single concrete target, so there
 * is no relation to follow from an override back to what it applies to.
 */
export const channelOverridesRelations = relations(
  channelPermissionOverrides,
  ({ one }) => ({
    channel: one(channels, {
      fields: [channelPermissionOverrides.channelId],
      references: [channels.id],
    }),
  })
);

/**
 * `replyTo` and `replies` are the two directions of the self-reference and
 * share a `relationName`, which is how Drizzle pairs them.
 */

export const guildEmojisRelations = relations(guildEmojis, ({ one }) => ({
  creator: one(user, {
    fields: [guildEmojis.createdBy],
    references: [user.id],
  }),
  guild: one(guilds, {
    fields: [guildEmojis.guildId],
    references: [guilds.id],
  }),
}));

export const channelReadStateRelations = relations(
  channelReadState,
  ({ one }) => ({
    channel: one(channels, {
      fields: [channelReadState.channelId],
      references: [channels.id],
    }),
    user: one(user, {
      fields: [channelReadState.userId],
      references: [user.id],
    }),
  })
);
