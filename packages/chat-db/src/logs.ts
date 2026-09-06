import type { Client } from "cassandra-driver";
import { types } from "cassandra-driver";
import { bucketFor, bucketForId, previousBucket } from "./buckets";

const INSERT_AUDIT = `
  INSERT INTO audit_logs_by_guild (
    guild_id, bucket_year_month, log_id, actor_id,
    action_type, target_id, changes_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_AUDIT = `
  SELECT log_id, actor_id, action_type, target_id, changes_json, created_at
    FROM audit_logs_by_guild
   WHERE guild_id = ? AND bucket_year_month = ? AND log_id < ?
   LIMIT ?`;

const INSERT_MOD = `
  INSERT INTO moderation_logs_by_guild (
    guild_id, log_id, target_user_id, moderator_id,
    action, reason, duration_seconds, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_MOD = `
  SELECT log_id, target_user_id, moderator_id, action, reason,
         duration_seconds, created_at
    FROM moderation_logs_by_guild
   WHERE guild_id = ? AND log_id < ?
   LIMIT ?`;

export async function writeAuditLog(
  client: Client,
  entry: {
    guildId: string;
    actorId: string;
    actionType: string;
    targetId: string | null;
    /** Serialised here, not by the caller, so the column is never half-encoded. */
    changes: unknown;
    /**
     * Supply one to preserve an original timestamp -- an import, a replay, a
     * backfill. Generated when absent, which is the live path.
     *
     * It is what decides the bucket, so a caller that mints an id and passes it
     * minutes later across a month boundary still lands in the right partition.
     */
    logId?: types.TimeUuid;
  }
): Promise<types.TimeUuid> {
  const logId = entry.logId ?? types.TimeUuid.now();
  await client.execute(
    INSERT_AUDIT,
    [
      entry.guildId,
      bucketForId(logId),
      logId,
      entry.actorId,
      entry.actionType,
      entry.targetId,
      JSON.stringify(entry.changes),
      logId.getDate(),
    ],
    { prepare: true }
  );
  return logId;
}

/** Bucket-walking read, same shape and same bound as the message reader. */
export async function getAuditLogs(
  client: Client,
  options: {
    guildId: string;
    before?: types.TimeUuid;
    limit?: number;
    maxBucketsScanned?: number;
  }
): Promise<{ rows: types.Row[]; cursor: types.TimeUuid | null }> {
  const limit = options.limit ?? 50;
  const maxBuckets = options.maxBucketsScanned ?? 12;
  let bucket = options.before
    ? bucketForId(options.before)
    : bucketFor(new Date());
  let cursor = options.before ?? types.TimeUuid.max(new Date(), 0);

  const rows: types.Row[] = [];
  for (let i = 0; i < maxBuckets && rows.length < limit; i += 1) {
    const result = await client.execute(
      SELECT_AUDIT,
      [options.guildId, bucket, cursor, limit - rows.length],
      { prepare: true }
    );
    rows.push(...result.rows);
    bucket = previousBucket(bucket);
    cursor = types.TimeUuid.max(new Date(), 0);
  }

  const last = rows.at(-1);
  return { cursor: last ? (last.log_id as types.TimeUuid) : null, rows };
}

export async function writeModerationLog(
  client: Client,
  entry: {
    guildId: string;
    targetUserId: string;
    moderatorId: string;
    action: string;
    reason: string | null;
    /** Null for permanent actions. bigint because a ban can outlive an int. */
    durationSeconds: bigint | null;
    /** Supply one to preserve an original timestamp. See `writeAuditLog`. */
    logId?: types.TimeUuid;
  }
): Promise<types.TimeUuid> {
  const logId = entry.logId ?? types.TimeUuid.now();
  await client.execute(
    INSERT_MOD,
    [
      entry.guildId,
      logId,
      entry.targetUserId,
      entry.moderatorId,
      entry.action,
      entry.reason,
      entry.durationSeconds === null ? null : entry.durationSeconds.toString(),
      logId.getDate(),
    ],
    { prepare: true }
  );
  return logId;
}

/**
 * No bucket walk: the table has no bucket in its partition key, so one query
 * reads the whole history. That is also why the partition is unbounded -- see
 * the note in cql/003_logs.cql.
 */
export async function getModerationLogs(
  client: Client,
  options: { guildId: string; before?: types.TimeUuid; limit?: number }
): Promise<{ rows: types.Row[]; cursor: types.TimeUuid | null }> {
  const limit = options.limit ?? 50;
  const cursor = options.before ?? types.TimeUuid.max(new Date(), 0);
  const result = await client.execute(
    SELECT_MOD,
    [options.guildId, cursor, limit],
    { prepare: true }
  );
  const last = result.rows.at(-1);
  return {
    cursor: last ? (last.log_id as types.TimeUuid) : null,
    rows: result.rows,
  };
}
