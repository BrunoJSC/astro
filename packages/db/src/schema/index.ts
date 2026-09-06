/**
 * Central schema barrel. `drizzle.config.ts` points here, and the client passes
 * this namespace to `drizzle()` to enable relational queries -- which is why
 * the relations have to be re-exported alongside the tables.
 *
 * The first block is written by `bun run auth:generate` in @repo/auth; the
 * second is hand-owned domain schema. `relations.ts` covers both, because
 * Drizzle allows one `relations()` call per table.
 */
export * from "./accounts";
export * from "./channel-overrides";
export * from "./channels";
export * from "./enums";
export * from "./friends";
export * from "./guild-members";
export * from "./guilds";
export * from "./invites";
export * from "./member-roles";
export * from "./relations";
export * from "./roles";
export * from "./sessions";
export * from "./users";
export * from "./verifications";
