import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { guilds } from "./guilds";
import { user } from "./users";

/**
 * Membership. The composite key is the identity -- a user is in a guild once.
 *
 * Column order matters: `(guildId, userId)` puts the guild first, because the
 * hot query is "list this guild's members", and the primary key index serves it
 * directly. The reverse question, "which guilds is this user in", gets its own
 * index below rather than a full scan.
 */
export const guildMembers = pgTable(
  "guild_members",
  {
    guildId: uuid("guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Per-guild display name override. Null means fall back to the profile. */
    nickname: text("nickname"),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId] }),
    index("guild_members_user_id_idx").on(table.userId),
  ]
);
