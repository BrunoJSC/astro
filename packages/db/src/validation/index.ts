/**
 * TypeBox schemas derived from the Drizzle tables.
 *
 * `createSchemaFactory` is re-exported so a consumer can rebuild these against
 * a different TypeBox instance -- `createSchemaFactory({ typeboxInstance: t })`
 * with Elysia's `t`, for instance. The schemas below need no such treatment:
 * `@sinclair/typebox` resolves to the single 0.34.x copy Elysia also uses, so
 * they are already valid Elysia route schemas.
 */
// Side-effect import, and it must come first: the schemas below annotate
// `format`, which TypeBox rejects outright until the name is registered.
import "./formats";

export { createSchemaFactory } from "drizzle-typebox";
export * from "./accounts";
export * from "./channels";
export * from "./friends";
export * from "./guilds";
export * from "./roles";
export * from "./sessions";
export * from "./users";
export * from "./verifications";
