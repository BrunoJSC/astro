import { sql } from "drizzle-orm";
import { bigint, index, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { channels } from "./channels";
import { permissionTargetType } from "./enums";

/**
 * Per-channel permission overrides, for a role or for a single member.
 *
 * `targetId` is polymorphic -- a role id or a user id, discriminated by
 * `targetType` -- so it carries NO foreign key. That is a real cost: deleting a
 * role leaves its overrides behind, and nothing in the database prevents it.
 * The alternatives are worse. Two nullable columns with a check constraint
 * doubles the width of the hottest permission-resolution query, and separate
 * tables per target type duplicate the resolution logic. Cleaning up orphans
 * belongs in the role-deletion path, and it is worth writing down that it does.
 *
 * `allow` and `deny` are the same 64-bit bitfields as `roles.permissions`.
 * Resolution order is Discord's: base role permissions, then role overrides,
 * then the member override, with deny applied before allow at each step.
 */
export const channelPermissionOverrides = pgTable(
  "channel_permission_overrides",
  {
    /*
     * The default is raw SQL, not `0n`. drizzle-kit 0.31.10 serialises its schema
     * snapshot with JSON.stringify, which throws "Do not know how to serialize a
     * BigInt" on a BigInt literal default -- migration generation fails outright.
     * `sql`0`` produces the same DEFAULT 0 in Postgres while keeping `mode:
     * "bigint"`, which is what gives the column a real 64-bit type in TypeScript.
     */
    allow: bigint("allow", { mode: "bigint" }).notNull().default(sql`0`),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    deny: bigint("deny", { mode: "bigint" }).notNull().default(sql`0`),
    /** A role id or a user id — see `targetType`. Deliberately unconstrained. */
    targetId: uuid("target_id").notNull(),
    targetType: permissionTargetType("target_type").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.channelId, table.targetId, table.targetType],
    }),
    // Resolving a channel's permissions reads every override it has, and the
    // primary key already leads with channelId — this one serves the reverse:
    // finding what to clean up when a role or member is removed.
    index("channel_overrides_target_idx").on(table.targetId, table.targetType),
  ]
);
