import { index, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { messages } from "./messages";
import { roles } from "./roles";
import { user } from "./users";

/**
 * Direct user mentions, one row per (message, user).
 *
 * Extracted from the message body at write time rather than parsed on read: the
 * "@me" inbox is a query across every channel a user belongs to, and re-parsing
 * message content to answer it is not a query at all.
 */
export const messageMentions = pgTable(
  "message_mentions",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.userId] }),
    /*
     * The inbox query: "my mentions, newest first". Descending on messageId is
     * chronological because ids are UUIDv7, so this index answers it as a
     * backwards range scan with no sort.
     *
     * `.nullsFirst()` for the same reason as the channel index in
     * ../messages.ts: Drizzle's `.desc()` emits `DESC NULLS LAST`, which does
     * not match the `DESC NULLS FIRST` that a bare `ORDER BY ... DESC` asks
     * for, and the planner then ignores the index entirely.
     */
    index("message_mentions_user_id_message_id_idx").on(
      table.userId,
      table.messageId.desc().nullsFirst()
    ),
  ]
);

/**
 * Role mentions, kept unexpanded.
 *
 * Storing one row per member of the mentioned role is the obvious model and the
 * wrong one: mentioning a role with fifty thousand members would write fifty
 * thousand rows for one message, and re-writing them whenever membership
 * changes is not tractable. The mention is stored against the role, and
 * expansion happens at read time by joining `member_roles` -- which is indexed
 * for exactly that.
 *
 * `@everyone` and `@here` are not here at all: they are a flag on the message
 * itself, since there is no role row to point at.
 */
export const messageRoleMentions = pgTable(
  "message_role_mentions",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.roleId] }),
    index("message_role_mentions_role_id_idx").on(table.roleId),
  ]
);
