import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { newId } from "../id";
import { messages } from "./messages";

/**
 * Files on a message. Its own table because most messages have none, and a
 * repeating group of columns on `messages` would widen the hottest row in the
 * system for a minority case.
 *
 * The bytes live in object storage; this table holds only the reference.
 * `onDelete: "cascade"` therefore drops the row, not the file -- reclaiming the
 * blob is a separate sweep, and it is worth writing down that deleting a
 * message does not by itself free the storage.
 */
export const attachments = pgTable(
  "attachments",
  {
    contentType: text("content_type"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    filename: text("filename").notNull(),
    height: integer("height"),
    id: uuid("id").primaryKey().$defaultFn(newId).default(sql`uuidv7()`),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** bigint: a 4-byte int caps at 2 GB, which uploads already exceed. */
    size: bigint("size", { mode: "bigint" }).notNull(),
    url: text("url").notNull(),
    /** Images and video only; null otherwise. */
    width: integer("width"),
  },
  (table) => [index("attachments_message_id_idx").on(table.messageId)]
);
