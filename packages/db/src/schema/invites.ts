import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { guilds } from "./guilds";
import { user } from "./users";

/**
 * Invite links.
 *
 * The code is the primary key rather than a surrogate uuid: it is what appears
 * in the URL and what every redemption looks up, so making it the key removes
 * an index and a join from the hottest path this table has.
 *
 * `uses` is a counter incremented on redemption. At scale it should be bumped
 * with `SET uses = uses + 1` and checked against `maxUses` in the same
 * statement -- reading, comparing and writing in application code races, and
 * the race is worth exactly one extra member past the limit.
 */
export const invites = pgTable(
  "invites",
  {
    code: text("code").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Null means it never expires. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    guildId: uuid("guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    /*
     * `set null`, not cascade: an invite outliving the account that created it
     * is correct. Deleting the inviter should not silently break every link
     * they ever shared.
     */
    inviterId: uuid("inviter_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** Null means unlimited. */
    maxUses: integer("max_uses"),
    uses: integer("uses").notNull().default(0),
  },
  (table) => [
    index("invites_guild_id_idx").on(table.guildId),
    // Serves the sweep that prunes expired invites.
    index("invites_expires_at_idx").on(table.expiresAt),
  ]
);
