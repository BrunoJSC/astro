import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { newId } from "../id";
import { guilds } from "./guilds";

/**
 * Guild roles.
 *
 * `permissions` is a 64-bit bitfield stored as `bigint` with `mode: "bigint"`,
 * which surfaces as a native `BigInt` in TypeScript. That mode is not optional:
 * JavaScript numbers lose precision above 2^53, and a permission set past bit
 * 53 would silently round -- granting or revoking flags nobody touched. The
 * alternative shapes are worse: JSON cannot be masked in SQL, and an array of
 * strings turns every permission check into a set operation.
 *
 * `position` is the hierarchy: higher wins, and a member's effective
 * permissions are the OR of every role they hold.
 */
export const roles = pgTable(
  "roles",
  {
    /** Packed 0xRRGGBB. 0 means "inherit", as in Discord. */
    color: integer("color").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    guildId: uuid("guild_id")
      .notNull()
      .references(() => guilds.id, { onDelete: "cascade" }),
    /** Whether members with this role are listed separately in the sidebar. */
    hoist: boolean("hoist").notNull().default(false),
    id: uuid("id").primaryKey().$defaultFn(newId).default(sql`uuidv7()`),
    name: text("name").notNull(),
    /*
     * The default is raw SQL, not `0n`. drizzle-kit 0.31.10 serialises its schema
     * snapshot with JSON.stringify, which throws "Do not know how to serialize a
     * BigInt" on a BigInt literal default -- migration generation fails outright.
     * `sql`0`` produces the same DEFAULT 0 in Postgres while keeping `mode:
     * "bigint"`, which is what gives the column a real 64-bit type in TypeScript.
     */
    permissions: bigint("permissions", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    position: integer("position").notNull().default(0),
  },
  (table) => [
    // Rendering a guild reads its roles in hierarchy order, so the index
    // carries the sort and the planner skips it.
    index("roles_guild_id_position_idx").on(table.guildId, table.position),
  ]
);
