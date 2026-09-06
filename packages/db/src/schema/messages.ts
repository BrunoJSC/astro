import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { newId } from "../id";
import { channels } from "./channels";
import { messageType } from "./enums";
import { user } from "./users";

/**
 * The hot table. Everything else in this schema is read thousands of times
 * less often, so the decisions here are the ones that matter.
 *
 * Ordering comes free from the primary key. Ids are UUIDv7, whose leading 48
 * bits are a millisecond timestamp, so `ORDER BY id` IS chronological order --
 * no separate index on `created_at`, and the pagination index below carries the
 * sort. That is the concrete payoff of choosing v7 over v4 back in `../id.ts`.
 *
 * Not modelled here, and deliberately: message content is never updated in
 * place at volume, so there is no `$onUpdate` -- `editedAt` is set explicitly
 * by the edit path, which is also what the client needs to render "(edited)".
 */
export const messages = pgTable(
  "messages",
  {
    /*
     * Nullable, with `set null`. Deleting an account must not erase its side of
     * every conversation it took part in -- the messages stay and render as a
     * deleted user, which is both what people expect and what makes a thread
     * still readable. Cascading here would silently punch holes in other
     * people's history.
     */
    authorId: uuid("author_id").references(() => user.id, {
      onDelete: "set null",
    }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    content: text("content").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /*
     * Soft delete. A hard DELETE at this volume cascades into reactions and
     * attachments and rewrites index pages under the read path; marking a row
     * is one page write. The cost is real and worth stating: every read must
     * filter on `deleted_at IS NULL`, and forgetting to leaks removed content.
     * The partial index below exists so that filter is free.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    id: uuid("id").primaryKey().$defaultFn(newId).default(sql`uuidv7()`),
    /*
     * Self-reference, `set null`: deleting the message someone replied to must
     * not delete the reply. The client renders the dangling case as "original
     * message was deleted".
     */
    replyToId: uuid("reply_to_id").references((): AnyPgColumn => messages.id, {
      onDelete: "set null",
    }),
    type: messageType("type").notNull().default("default"),
  },
  (table) => [
    /*
     * THE index. Every channel read is "the newest N messages before a cursor",
     * and this serves it as a backwards range scan with no sort step. Partial
     * on `deleted_at IS NULL` so tombstones neither occupy it nor have to be
     * filtered out afterwards.
     */
    index("messages_channel_id_id_idx")
      .on(table.channelId, table.id.desc())
      .where(sql`${table.deletedAt} is null`),
    // Moderation and account deletion: "everything this user wrote".
    index("messages_author_id_idx").on(table.authorId),
    // Loading a reply chain.
    index("messages_reply_to_id_idx").on(table.replyToId),
    /*
     * A ceiling, not a business rule -- the product decides the real limit.
     * This exists so a bug or an abusive client cannot write a megabyte into
     * the hottest table in the system.
     */
    check("messages_content_length", sql`length(${table.content}) <= 4000`),
  ]
);
