import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { newId } from "../id";
import { guildEmojis } from "./emojis";
import { messages } from "./messages";
import { user } from "./users";

/**
 * One row per (message, user, emoji). The per-user grain is the source of
 * truth: it is what answers "did I react", what enforces one reaction per
 * person per emoji, and what makes removing a reaction a delete rather than a
 * decrement that can drift.
 *
 * A reaction is EITHER a Unicode character or a custom emoji, never both and
 * never neither -- enforced by the check constraint rather than by convention,
 * because a row with both set has no defined rendering.
 *
 * Counting: `SELECT emoji, count(*) ... GROUP BY emoji` over the
 * `(message_id, ...)` index is an index-only scan of a handful of rows for any
 * realistic message. A denormalised counter column is the next step if that
 * ever stops being true, and it is a real step -- it needs the increment to
 * happen in the same transaction as the insert, or the two diverge.
 */
export const messageReactions = pgTable(
  "message_reactions",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /*
     * `cascade`: deleting a custom emoji removes the reactions that used it.
     * The alternative -- keeping them with a dangling reference -- renders as a
     * broken image on every message it ever appeared on.
     */
    customEmojiId: uuid("custom_emoji_id").references(() => guildEmojis.id, {
      onDelete: "cascade",
    }),
    /** The Unicode character itself, e.g. "🎉". Null for custom emoji. */
    emoji: text("emoji"),
    /*
     * A surrogate key, and it is not decoration.
     *
     * The obvious model is a composite primary key over (message, user, emoji,
     * custom_emoji). It does not work: Postgres makes every primary-key column
     * implicitly NOT NULL, so both emoji columns become mandatory -- and the
     * check below then requires exactly one of them to be null. The two
     * constraints are jointly unsatisfiable, and the table accepts no rows at
     * all. That is not a theory; the migration applied cleanly and every insert
     * was rejected.
     *
     * So identity moves to a surrogate id, and uniqueness moves to the index
     * below, which can hold nulls.
     */
    id: uuid("id").primaryKey().$defaultFn(newId).default(sql`uuidv7()`),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    /*
     * `NULLS NOT DISTINCT` is load-bearing. Postgres treats nulls as distinct
     * in a unique index by default, so with one emoji column always null, every
     * pair of rows would look different and the same user could react with the
     * same emoji any number of times. Postgres 15 added the modifier; this runs
     * on 18.
     */
    unique("message_reactions_unique")
      .on(table.messageId, table.userId, table.emoji, table.customEmojiId)
      .nullsNotDistinct(),
    // Reading a message's reaction summary, grouped by emoji.
    index("message_reactions_message_emoji_idx").on(
      table.messageId,
      table.emoji,
      table.customEmojiId
    ),
    // Account deletion, and "what did I react to".
    index("message_reactions_user_id_idx").on(table.userId),
    index("message_reactions_custom_emoji_id_idx").on(table.customEmojiId),
    // Exactly one of the two is set.
    check(
      "message_reactions_one_emoji",
      sql`(${table.emoji} is null) <> (${table.customEmojiId} is null)`
    ),
  ]
);
