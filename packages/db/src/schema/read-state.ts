import {
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { channels } from "./channels";
import { user } from "./users";

/**
 * How far each user has read in each channel.
 *
 * Write-heavy in a way the rest of the schema is not: one row is touched every
 * time anyone opens a channel, so it is written roughly as often as messages
 * are read. The row is kept narrow for that reason -- five columns, no text.
 *
 * `lastReadMessageId` carries NO foreign key, and that turned out to matter
 * more than originally intended: message history lives in ScyllaDB, so there is
 * no Postgres row to point at even in principle. The column stores the Scylla
 * `timeuuid` of the last read message.
 *
 * It is opaque to Postgres, and that is a real constraint. A timeuuid is
 * UUIDv1, whose timestamp is laid out low-bits-first, so Postgres comparing two
 * of them bytewise does NOT compare them chronologically. Never write
 * `WHERE ... > last_read_message_id` here. The unread comparison belongs in
 * Scylla, whose `timeuuid` type sorts by the embedded timestamp -- see
 * `@repo/chat-db`.
 *
 * What Postgres still gives is the sidebar in one query: every channel a user
 * has state for, with its badge count, without touching Scylla at all.
 */
export const channelReadState = pgTable(
  "channel_read_state",
  {
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** Watermark. Null means nothing has been read yet. */
    lastReadMessageId: uuid("last_read_message_id"),
    /*
     * Denormalised badge count, and it has to be maintained: incremented when a
     * mention is written, reset to 0 when the channel is read. Both must happen
     * in the same transaction as the thing they follow, or the badge drifts
     * from the mentions table and stays wrong until someone recomputes it.
     *
     * It exists because the alternative -- counting rows in `message_mentions`
     * for every channel in the sidebar on every load -- is a query per channel
     * per render.
     */
    mentionCount: integer("mention_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    // Rendering the sidebar reads every channel for one user, so the user comes
    // first and the primary key index serves it directly.
    primaryKey({ columns: [table.userId, table.channelId] }),
    // Fan-out on a new message: who has this channel open, and who to notify.
    index("channel_read_state_channel_id_idx").on(table.channelId),
  ]
);
