import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { friendStatus } from "./enums";
import { user } from "./users";

/**
 * Friendships and friend requests, as one self-referencing M:N edge.
 *
 * The pair is stored CANONICALLY: `userId1 < userId2`, enforced by a check
 * constraint. Without it the composite key does not do what it looks like it
 * does -- (A,B) and (B,A) are two different rows, so the same friendship can
 * exist twice, and "are these two friends?" needs an OR across both column
 * orders on every lookup.
 *
 * Ordering the pair discards direction, which matters for the two directional
 * states: a pending request has a sender, and a block has a blocker. That is
 * what `requesterId` carries -- with the pair canonical AND the actor recorded,
 * a single row answers both "is there an edge" and "who initiated it".
 *
 * A "blocked" row therefore means: `requesterId` blocked the other user.
 */
export const friends = pgTable(
  "friends",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Who sent the request, or who did the blocking. Always one of the pair. */
    requesterId: uuid("requester_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: friendStatus("status").notNull().default("pending"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    userId1: uuid("user_id_1")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    userId2: uuid("user_id_2")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    // The pair IS the identity of the edge, so it is the primary key -- a
    // separate surrogate id would allow duplicates the moment anyone forgot the
    // unique index.
    primaryKey({ columns: [table.userId1, table.userId2] }),
    // Enforces the canonical order the whole design rests on. Also rejects
    // self-friendship, since `id < id` is false.
    check("friends_canonical_order", sql`${table.userId1} < ${table.userId2}`),
    // "My friends" reads from the second column too, which the primary key's
    // index cannot serve -- it is ordered by user_id_1 first.
    index("friends_user_id_2_idx").on(table.userId2, table.status),
    index("friends_user_id_1_status_idx").on(table.userId1, table.status),
  ]
);

/**
 * Orders a pair the way the table stores it. Every write must go through this,
 * or the check constraint rejects the row.
 */
export function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}
