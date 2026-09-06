/**
 * Central schema barrel. `drizzle.config.ts` points here, and the client
 * passes this namespace to `drizzle()` to enable relational queries -- which
 * is why the relations have to be re-exported alongside the tables.
 */
export * from "./accounts";
export * from "./relations";
export * from "./sessions";
export * from "./users";
export * from "./verifications";
