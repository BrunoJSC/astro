import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
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
     * A column on the hottest table, for a reason: `@everyone` has no role row
     * to point at, so it cannot live in `message_role_mentions`, and the badge
     * calculation needs it. A boolean fits in existing alignment padding here,
     * so it costs nothing per row -- unlike the join a side table would add to
     * every unread computation.
     */
    mentionsEveryone: boolean("mentions_everyone").notNull().default(false),
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
     * The pagination index: "the newest N messages before a cursor", as a
     * backwards range scan with no sort step. Partial on `deleted_at IS NULL`
     * so tombstones neither occupy it nor have to be filtered afterwards.
     *
     * MEASURED CAVEAT. The planner does not always choose it. With 785k rows
     * across 61 channels, `WHERE channel_id = X ORDER BY id DESC LIMIT 50`
     * picked `messages_pkey` and scanned backwards, discarding 472,000 rows to
     * find 50 -- 88ms, against microseconds for the index. Its cost estimate
     * for that plan was 229, because it assumes matching rows appear early in
     * the scan.
     *
     * That assumption holds when a channel is busy: ids interleave across
     * channels, so a backward scan hits the target every few rows. It breaks
     * for a QUIET channel in a busy server -- scanning back from "now" then
     * traverses everything newer. Neither `ORDER BY channel_id, id DESC` nor
     * `CREATE STATISTICS (dependencies, mcv)` changed the choice; both were
     * tried.
     *
     * The structural answer is partitioning `messages` by channel, which makes
     * each partition's own scan channel-local. Drizzle cannot declare
     * partitions, so that is a raw-SQL migration and a deliberate decision, not
     * something to slip in here.
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
