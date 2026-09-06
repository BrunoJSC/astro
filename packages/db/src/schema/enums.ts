import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Native enums rather than `text` with a CHECK: Postgres stores an enum as a
 * 4-byte oid instead of the string, and adding a value later is a catalog
 * change (`ALTER TYPE ... ADD VALUE`) rather than a table rewrite.
 *
 * The cost is that removing or reordering a value is genuinely hard. These are
 * closed sets by nature, so that trade is the right way round.
 */
export const friendStatus = pgEnum("friend_status", [
  "pending",
  "accepted",
  "blocked",
]);

export const channelType = pgEnum("channel_type", [
  "text",
  "voice",
  "category",
  "dm",
  "group_dm",
]);

export const permissionTargetType = pgEnum("permission_target_type", [
  "role",
  "member",
]);
