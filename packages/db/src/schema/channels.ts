import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { newId } from "../id";
import { channelType } from "./enums";
import { guilds } from "./guilds";

/**
 * Channels, categories and DMs in one table.
 *
 * They share it because they share a permission model, a message stream and an
 * id space: a DM and a guild text channel are the same thing to everything
 * downstream. `guildId` is nullable and that is the discriminator -- null means
 * a DM or group DM, which belongs to no guild.
 *
 * `categoryId` is a self-reference. Categories are channels of type
 * `"category"` with a null parent; nothing enforces that a category's parent is
 * itself null, because a one-level tree is a convention, not an invariant the
 * schema can express without a trigger.
 */
export const channels = pgTable(
  "channels",
  {
    /** Voice only, bits per second. */
    bitrate: integer("bitrate"),
    /*
     * The explicit type annotation is required, not stylistic: a
     * self-referencing column makes the inferred type circular and TypeScript
     * refuses to name it.
     */
    categoryId: uuid("category_id").references((): AnyPgColumn => channels.id, {
      // The children survive; the app lifts them to the root.
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Null for DMs and group DMs. */
    guildId: uuid("guild_id").references(() => guilds.id, {
      onDelete: "cascade",
    }),
    id: uuid("id").primaryKey().$defaultFn(newId).default(sql`uuidv7()`),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    /** Text channels only. */
    topic: text("topic"),
    type: channelType("type").notNull(),
    /** Voice only. Null or 0 means no limit. */
    userLimit: integer("user_limit"),
  },
  (table) => [
    // The channel list of a guild, already in render order.
    index("channels_guild_id_position_idx").on(table.guildId, table.position),
    index("channels_category_id_idx").on(table.categoryId),
  ]
);
