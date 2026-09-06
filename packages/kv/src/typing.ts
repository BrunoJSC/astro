import type { KvClient } from "./client";
import { typingIndexKey, typingKey } from "./keys";
import type { TypingEntry } from "./types";

/**
 * Eight seconds, per the spec, and the number is load-bearing.
 *
 * The client re-sends "still typing" every few seconds while keys are being
 * pressed; the TTL just has to outlive the gap between two of those. Longer and
 * a user who walked away keeps typing forever; shorter and the indicator
 * flickers between keystrokes.
 */
export const TYPING_TTL_MS = 8000;

/**
 * Start typing, or push the indicator out by another window.
 *
 * There is no `stopTyping` on the timeout path, and that is the point of the
 * TTL: nothing has to fire, no timer is held on any node, and a node that dies
 * mid-message does not leave someone typing forever. `stopTyping` exists only
 * for the explicit case -- the message was sent, or the box was cleared.
 */
export async function startTyping(
  client: KvClient,
  channelId: string,
  userId: string,
  ttlMs = TYPING_TTL_MS
): Promise<void> {
  await client.typingStart(
    typingKey(channelId, userId),
    typingIndexKey(channelId),
    userId,
    Date.now(),
    ttlMs
  );
}

export async function stopTyping(
  client: KvClient,
  channelId: string,
  userId: string
): Promise<void> {
  await client.typingStop(
    typingKey(channelId, userId),
    typingIndexKey(channelId),
    userId
  );
}

/**
 * Who is typing in a channel, newest expiry last.
 *
 * Reads the index, not the per-user keys. Answering this from the keys
 * themselves would mean matching `channel:typing:{c}:*`, and both ways of doing
 * that are unacceptable on a live server: KEYS blocks it for the length of the
 * whole keyspace, and SCAN walks every key in the database for an answer needed
 * on every keystroke in every open channel.
 *
 * Lapsed entries are pruned as part of the read, so the index cannot drift
 * away from the keys it indexes.
 */
export async function getTyping(
  client: KvClient,
  channelId: string
): Promise<TypingEntry[]> {
  const flat = await client.typingList(typingIndexKey(channelId), Date.now());
  const entries: TypingEntry[] = [];

  // ZRANGE ... WITHSCORES answers as a flat [member, score, member, score...].
  for (let i = 0; i < flat.length; i += 2) {
    const userId = flat[i];
    const score = flat[i + 1];
    if (userId && score) {
      entries.push({ expiresAt: Number(score), userId });
    }
  }

  return entries;
}
