import { type Static, Type } from "@sinclair/typebox";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-typebox";
import { attachments } from "../schema/attachments";
import { messages } from "../schema/messages";
import { messageReactions } from "../schema/reactions";

/** Mirrors the table's check constraint, so a rejection happens before the round trip. */
const messageContent = Type.String({
  description: "Message body. The table enforces the same ceiling.",
  maxLength: 4000,
});

export const selectMessageSchema = createSelectSchema(messages, {
  content: messageContent,
});
export type Message = Static<typeof selectMessageSchema>;

export const insertMessageSchema = createInsertSchema(messages, {
  content: messageContent,
});
export type InsertMessage = Static<typeof insertMessageSchema>;

export const updateMessageSchema = createUpdateSchema(messages, {
  content: Type.Optional(messageContent),
});
export type UpdateMessage = Static<typeof updateMessageSchema>;

/**
 * `channelId` comes from the route and `authorId` from the session -- accepting
 * either would let a client post into a channel it cannot see, as someone else.
 * `type` is omitted because system messages are written by the server, never
 * submitted: a client that could set `member_join` could forge history.
 */
export const createMessageDto = Type.Object({
  content: messageContent,
  replyToId: Type.Optional(
    Type.String({
      description: "The message being replied to, if any.",
      format: "uuid",
    })
  ),
});
export type CreateMessageDto = Static<typeof createMessageDto>;

/**
 * Only the body. `editedAt` is stamped by the server, and `deletedAt` belongs
 * to the delete endpoint -- letting an edit clear it would resurrect a removed
 * message.
 */
export const updateMessageDto = Type.Object({ content: messageContent });
export type UpdateMessageDto = Static<typeof updateMessageDto>;

/**
 * Keyset pagination, not offset. `OFFSET n` makes Postgres walk and discard n
 * rows, so page 500 of a busy channel costs 500 times page 1 -- and a message
 * arriving mid-scroll shifts every subsequent page. A cursor on the id is a
 * range scan on the `(channel_id, id DESC)` index regardless of depth, and ids
 * are UUIDv7, so ordering by id IS chronological.
 */
export const listMessagesQuery = Type.Object({
  after: Type.Optional(
    Type.String({
      description: "Return messages newer than this id.",
      format: "uuid",
    })
  ),
  before: Type.Optional(
    Type.String({
      description: "Return messages older than this id.",
      format: "uuid",
    })
  ),
  limit: Type.Optional(Type.Integer({ default: 50, maximum: 100, minimum: 1 })),
});
export type ListMessagesQuery = Static<typeof listMessagesQuery>;

export const selectAttachmentSchema = createSelectSchema(attachments);
export type Attachment = Static<typeof selectAttachmentSchema>;

export const selectReactionSchema = createSelectSchema(messageReactions);
export type MessageReaction = Static<typeof selectReactionSchema>;

/**
 * Exactly one of the two, matching the table's check constraint. A union rather
 * than two optional fields, so "neither" and "both" are unrepresentable rather
 * than merely rejected later.
 */
export const toggleReactionDto = Type.Union(
  [
    Type.Object({
      emoji: Type.String({
        description: "A Unicode emoji character.",
        maxLength: 16,
        minLength: 1,
      }),
    }),
    Type.Object({
      customEmojiId: Type.String({
        description: "A custom emoji belonging to the guild.",
        format: "uuid",
      }),
    }),
  ],
  { description: "Either a Unicode emoji or a custom one, never both." }
);
export type ToggleReactionDto = Static<typeof toggleReactionDto>;
