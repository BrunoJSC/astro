import type { KvClient } from "./client";
import { userStatusKey, voiceMembersKey } from "./keys";
import type { VoiceMember, VoiceMemberState } from "./types";

/**
 * Voice channel rosters.
 *
 * The hash has no TTL, deliberately: a voice channel is occupied until someone
 * leaves, and expiring the roster would drop everyone mid-call the moment the
 * clock ran out. The cost of that choice is that nothing cleans up after a
 * crashed node -- which is what `sweepVoiceChannel` is for.
 */

export async function joinVoice(
  client: KvClient,
  channelId: string,
  userId: string,
  state: Omit<VoiceMemberState, "joinedAt"> & { joinedAt?: number }
): Promise<number> {
  const payload: VoiceMemberState = {
    joinedAt: state.joinedAt ?? Date.now(),
    peerId: state.peerId,
    selfDeaf: state.selfDeaf,
    selfMute: state.selfMute,
    serverDeaf: state.serverDeaf,
    serverMute: state.serverMute,
  };

  return await client.voiceJoin(
    voiceMembersKey(channelId),
    userId,
    JSON.stringify(payload)
  );
}

/**
 * Patch one member's state -- a mute toggle, a server-side deafen.
 *
 * Read-modify-write, so it is not atomic against a concurrent update to the
 * same member. That is acceptable here and nowhere else in this package: the
 * only writers for a given user are that user's own client and a moderator
 * action, and the losing write is a mute flag that the next state broadcast
 * corrects. Do not copy this shape for anything that counts.
 */
export async function updateVoiceState(
  client: KvClient,
  channelId: string,
  userId: string,
  patch: Partial<VoiceMemberState>
): Promise<VoiceMemberState | null> {
  const raw = await client.hget(voiceMembersKey(channelId), userId);
  if (!raw) {
    return null;
  }

  const current = parseState(raw);
  if (!current) {
    return null;
  }

  const next: VoiceMemberState = { ...current, ...patch };
  await client.hset(voiceMembersKey(channelId), userId, JSON.stringify(next));
  return next;
}

/** Returns the members still in the channel. Zero means the call ended. */
export async function leaveVoice(
  client: KvClient,
  channelId: string,
  userId: string
): Promise<number> {
  return await client.voiceLeave(voiceMembersKey(channelId), userId);
}

export async function getVoiceMembers(
  client: KvClient,
  channelId: string
): Promise<VoiceMember[]> {
  const raw = await client.hgetall(voiceMembersKey(channelId));
  const members: VoiceMember[] = [];

  for (const [userId, value] of Object.entries(raw)) {
    const state = parseState(value);
    if (state) {
      members.push({ ...state, userId });
    }
  }

  return members;
}

/**
 * Remove members whose presence is gone -- the ghosts a crashed node leaves.
 *
 * Not a Lua script, and not for lack of trying. The roster lives under
 * `{channel_id}` and each presence key under `{user_id}`, so in Redis Cluster
 * they are on different nodes; a script touching both is rejected with
 * CROSSSLOT. Co-locating them would mean tagging presence by channel, which is
 * wrong -- a user has one presence and many channels.
 *
 * So it is a pipeline of EXISTS followed by an HDEL of the misses. The window
 * between the two is harmless: a user who reconnects in that gap is re-added
 * by their own join, and one who leaves is removed twice.
 *
 * Call it when a node is known to have died, or on a slow timer per active
 * channel. Not on every read.
 */
export async function sweepVoiceChannel(
  client: KvClient,
  channelId: string
): Promise<string[]> {
  const members = await getVoiceMembers(client, channelId);
  if (members.length === 0) {
    return [];
  }

  const pipeline = client.pipeline();
  for (const member of members) {
    pipeline.exists(userStatusKey(member.userId));
  }
  const results = await pipeline.exec();

  const ghosts: string[] = [];
  results?.forEach(([error, value], index) => {
    const member = members[index];
    if (!error && member && value === 0) {
      ghosts.push(member.userId);
    }
  });

  if (ghosts.length > 0) {
    await client.hdel(voiceMembersKey(channelId), ...ghosts);
  }

  return ghosts;
}

function parseState(raw: string): VoiceMemberState | null {
  try {
    return JSON.parse(raw) as VoiceMemberState;
  } catch {
    // A malformed value must not take down a whole roster read. It can only
    // come from a writer outside this package, or a half-finished migration.
    return null;
  }
}
