import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { bench, run, summary } from "mitata";
import { v4, v7 } from "uuid";

/**
 * Query-builder throughput. Deliberately measures SQL generation only --
 * `.toSQL()` never opens a socket, so the numbers are not polluted by network
 * or database time and the benchmark runs in CI without a live Postgres.
 *
 * Uses a local table rather than `@repo/db`'s schema, which is still empty.
 */
const users = pgTable("users", {
  createdAt: timestamp("created_at").notNull().defaultNow(),
  email: text("email").notNull(),
  id: text("id").primaryKey(),
});

const db = drizzle.mock({ casing: "snake_case", schema: { users } });

summary(() => {
  // v7 buys sequential B-tree inserts at ~5x the generation cost of v4 --
  // which is still ~0.7 us, four orders of magnitude below the INSERT it
  // precedes, so the trade is free in any realistic path.
  bench("newId (uuid v7)", () => v7());

  bench("uuid v4 (baseline)", () => v4());

  bench("select all", () => db.select().from(users).toSQL());

  bench("select + where", () =>
    db.select().from(users).where(eq(users.id, "u_1")).toSQL()
  );

  bench("insert one", () =>
    db.insert(users).values({ email: "a@b.c", id: "u_1" }).toSQL()
  );

  bench("update one", () =>
    db.update(users).set({ email: "x@y.z" }).where(eq(users.id, "u_1")).toSQL()
  );
});

await run();
