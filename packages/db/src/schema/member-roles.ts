import {
  foreignKey,
  index,
  pgTable,
  primaryKey,
  uuid,
} from "drizzle-orm/pg-core";
import { guildMembers } from "./guild-members";
import { roles } from "./roles";

/**
 * Which roles a member holds.
 *
 * `guildId` is carried alongside `userId` so the foreign key can point at
 * `guild_members` as a pair. Referencing the user alone would let a row assign
 * a role from guild A to someone who is only a member of guild B -- the
 * database would accept it, and the permission check would quietly grant it.
 * The composite FK makes that unrepresentable.
 */
export const memberRoles = pgTable(
  "member_roles",
  {
    guildId: uuid("guild_id").notNull(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId, table.roleId] }),
    foreignKey({
      columns: [table.guildId, table.userId],
      foreignColumns: [guildMembers.guildId, guildMembers.userId],
      name: "member_roles_member_fk",
    }).onDelete("cascade"),
    // "Who holds this role" — for permission recalculation when a role changes.
    index("member_roles_role_id_idx").on(table.roleId),
  ]
);
