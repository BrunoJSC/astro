import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { newId } from "../id";
import { user } from "./users";

/**
 * A server, in Discord's vocabulary. `guild` is the API-level name and the one
 * used throughout this schema, to stay unambiguous against `apps/server`.
 */
export const guilds = pgTable(
  "guilds",
  {
    bannerUrl: text("banner_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    iconUrl: text("icon_url"),
    id: uuid("id").primaryKey().$defaultFn(newId).default(sql`uuidv7()`),
    name: text("name").notNull(),
    /*
     * `restrict`, not `cascade`. Deleting an account must not silently destroy
     * every server that account happened to own, along with everyone else's
     * messages in them. Ownership has to be transferred first, and the FK is
     * what forces that conversation.
     */
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
  },
  (table) => [index("guilds_owner_id_idx").on(table.ownerId)]
);
