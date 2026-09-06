import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { newId } from "../id";
import { guilds } from "./guilds";
import { user } from "./users";

/**
 * Custom emoji uploaded to a guild.
 *
 * Exists because reactions have to reference something. A reaction is either a
 * Unicode character, which needs no table, or one of these -- and modelling the
 * second as a bare string would leave no way to rename an emoji, or to find
 * every reaction using one when it is deleted.
 */
export const guildEmojis = pgTable(
  "guild_emojis",
  {
    animated: boolean("animated").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdBy: uuid("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    guildId: uuid("guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    id: uuid("id").primaryKey().$defaultFn(newId).default(sql`uuidv7()`),
    /** Without colons. `:tada:` is stored as `tada`. */
    name: text("name").notNull(),
    url: text("url").notNull(),
  },
  (table) => [
    // `:tada:` has to resolve to exactly one emoji within a guild.
    unique("guild_emojis_guild_id_name_key").on(table.guildId, table.name),
    index("guild_emojis_guild_id_idx").on(table.guildId),
  ]
);
