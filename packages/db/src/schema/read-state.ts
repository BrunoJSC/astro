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
 * `lastReadMessageId` carries NO foreign key, and that is deliberate. It is a
 * watermark, not a reference: unread means "messages exist in this channel with
 * `id > lastReadMessageId`", which UUIDv7 makes a plain range scan on the
 * `(channel_id, id DESC)` index. A foreign key with `set null` would be
 * actively harmful -- purging one message would reset the watermark and mark
 * the entire channel unread for that user. The id is a position in time and
 * stays meaningful after the row it names is gone.
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
