import { describe, expect, it } from "bun:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { canonicalPair } from "../../src/schema/friends";
import * as schema from "../../src/schema/index";

describe("domain tables", () => {
  it("declares every entity", () => {
    for (const table of [
      schema.friends,
      schema.guilds,
      schema.guildMembers,
      schema.invites,
      schema.roles,
      schema.memberRoles,
      schema.channels,
      schema.channelPermissionOverrides,
      schema.channelReadState,
    ]) {
      expect(table).toBeDefined();
    }
  });

  it("uses native uuid for every generated primary key", () => {
    // 16 bytes instead of 37, and compared as a 128-bit value rather than
    // through text collation.
    for (const table of [schema.guilds, schema.roles, schema.channels]) {
      expect(getTableColumns(table).id.columnType).toBe("PgUUID");
    }
  });

  it("types permission bitfields as 64-bit", () => {
    // JavaScript numbers lose precision above 2^53; a flag past that bit would
    // round silently.
    expect(getTableColumns(schema.roles).permissions.columnType).toBe(
      "PgBigInt64"
    );
    expect(
      getTableColumns(schema.channelPermissionOverrides).allow.columnType
    ).toBe("PgBigInt64");
  });

  it("leaves guildId nullable on channels, which is what marks a DM", () => {
    expect(getTableColumns(schema.channels).guildId.notNull).toBe(false);
  });

  it("names the tables in snake_case plural", () => {
    expect(getTableName(schema.guildMembers)).toBe("guild_members");
    expect(getTableName(schema.channelPermissionOverrides)).toBe(
      "channel_permission_overrides"
    );
  });
});

describe("canonicalPair", () => {
  /*
   * The whole friends design rests on this: the pair is stored ordered, so the
   * composite primary key actually prevents a duplicate relationship. Without
   * it (A,B) and (B,A) are two rows and "are these two friends" needs an OR
   * across both column orders on every read.
   */
  it("orders a pair the same way regardless of argument order", () => {
    const a = "01a00000-0000-7000-8000-000000000001";
    const b = "01a00000-0000-7000-8000-000000000002";
    expect(canonicalPair(a, b)).toEqual([a, b]);
    expect(canonicalPair(b, a)).toEqual([a, b]);
  });

  it("is idempotent", () => {
    const a = "01a00000-0000-7000-8000-00000000000a";
    const b = "01a00000-0000-7000-8000-00000000000b";
    const once = canonicalPair(a, b);
    expect(canonicalPair(once[0], once[1])).toEqual(once);
  });
});

describe("read state after the move to Scylla", () => {
  it("keeps lastReadMessageId free of a foreign key", () => {
    /*
     * There is no Postgres row to point at any more -- message history lives in
     * ScyllaDB. The column stores a Scylla timeuuid, opaque to Postgres: UUIDv1
     * lays its timestamp out low-bits-first, so a bytewise comparison here is
     * not chronological. The unread comparison belongs in Scylla.
     */
    const referenced = getTableConfig(
      schema.channelReadState
    ).foreignKeys.flatMap((fk) => fk.reference().columns.map((c) => c.name));
    expect(referenced).not.toContain("last_read_message_id");
    expect(referenced.sort()).toEqual(["channel_id", "user_id"]);
  });
});
