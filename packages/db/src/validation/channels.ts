import { type Static, Type } from "@sinclair/typebox";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-typebox";
import { channelPermissionOverrides } from "../schema/channel-overrides";
import { channels } from "../schema/channels";

const channelName = Type.String({
  description:
    "Channel name. Lower-cased with dashes for text channels by convention; the schema does not enforce it.",
  maxLength: 100,
  minLength: 1,
});

export const selectChannelSchema = createSelectSchema(channels, {
  name: channelName,
});
export type Channel = Static<typeof selectChannelSchema>;

export const insertChannelSchema = createInsertSchema(channels, {
  name: channelName,
});
export type InsertChannel = Static<typeof insertChannelSchema>;

export const updateChannelSchema = createUpdateSchema(channels, {
  name: Type.Optional(channelName),
});
export type UpdateChannel = Static<typeof updateChannelSchema>;

/**
 * `guildId` is omitted: it comes from the route, not the body.
 *
 * Voice-only fields stay optional here rather than being split per type. The
 * schema cannot express "bitrate only when type is voice" without a union that
 * would double every consumer's branching -- that rule belongs in the handler,
 * where the type is already known.
 */
export const createChannelDto = Type.Omit(insertChannelSchema, [
  "id",
  "createdAt",
  "guildId",
]);
export type CreateChannelDto = Static<typeof createChannelDto>;

/** `type` is absent: converting a text channel into a voice one is not an edit. */
export const updateChannelDto = Type.Partial(
  Type.Omit(updateChannelSchema, ["id", "createdAt", "guildId", "type"])
);
export type UpdateChannelDto = Static<typeof updateChannelDto>;

export const selectChannelOverrideSchema = createSelectSchema(
  channelPermissionOverrides
);
export type ChannelOverride = Static<typeof selectChannelOverrideSchema>;

/**
 * `allow` and `deny` arrive as decimal strings, not numbers.
 *
 * They are 64-bit bitfields, and JSON numbers are IEEE 754 doubles: any flag
 * above bit 53 would be silently rounded in transit. The handler parses them
 * with `BigInt()` before they reach the column.
 */
export const upsertChannelOverrideDto = Type.Object({
  allow: Type.String({
    description: "64-bit permission bitfield, as a decimal string.",
    pattern: "^\\d+$",
  }),
  deny: Type.String({
    description: "64-bit permission bitfield, as a decimal string.",
    pattern: "^\\d+$",
  }),
  targetId: Type.String({ format: "uuid" }),
  targetType: Type.Union([Type.Literal("role"), Type.Literal("member")]),
});
export type UpsertChannelOverrideDto = Static<typeof upsertChannelOverrideDto>;
