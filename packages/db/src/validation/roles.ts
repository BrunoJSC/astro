import { type Static, Type } from "@sinclair/typebox";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-typebox";
import { memberRoles } from "../schema/member-roles";
import { roles } from "../schema/roles";

const roleName = Type.String({
  description: "Role name.",
  maxLength: 100,
  minLength: 1,
});

const roleColor = Type.Integer({
  description: "Packed 0xRRGGBB. 0 means inherit.",
  maximum: 0xff_ff_ff,
  minimum: 0,
});

export const selectRoleSchema = createSelectSchema(roles, {
  color: roleColor,
  name: roleName,
});
export type Role = Static<typeof selectRoleSchema>;

export const insertRoleSchema = createInsertSchema(roles, {
  color: Type.Optional(roleColor),
  name: roleName,
});
export type InsertRole = Static<typeof insertRoleSchema>;

export const updateRoleSchema = createUpdateSchema(roles, {
  color: Type.Optional(roleColor),
  name: Type.Optional(roleName),
});
export type UpdateRole = Static<typeof updateRoleSchema>;

/**
 * `permissions` is a decimal STRING on the wire, then `BigInt()` in the handler.
 *
 * The column is a 64-bit bitfield and JSON numbers are doubles -- sending it as
 * a number silently rounds any flag above bit 53, granting or revoking
 * permissions nobody touched. That is why the generated schema's `bigint` type
 * is replaced here rather than passed through.
 */
const permissionBits = Type.String({
  description: "64-bit permission bitfield, as a decimal string.",
  pattern: "^\\d+$",
});

export const createRoleDto = Type.Composite([
  Type.Omit(insertRoleSchema, [
    "id",
    "createdAt",
    "guildId",
    "permissions",
    "position",
  ]),
  Type.Object({ permissions: Type.Optional(permissionBits) }),
]);
export type CreateRoleDto = Static<typeof createRoleDto>;

export const updateRoleDto = Type.Composite([
  Type.Partial(
    Type.Omit(updateRoleSchema, ["id", "createdAt", "guildId", "permissions"])
  ),
  Type.Object({ permissions: Type.Optional(permissionBits) }),
]);
export type UpdateRoleDto = Static<typeof updateRoleDto>;

export const selectMemberRoleSchema = createSelectSchema(memberRoles);
export type MemberRole = Static<typeof selectMemberRoleSchema>;

/**
 * Reordering the hierarchy in one call. Sent as a batch because positions are
 * relative: applying them one at a time leaves the list transiently
 * inconsistent, and a failure halfway through leaves it permanently so.
 */
export const reorderRolesDto = Type.Object({
  positions: Type.Array(
    Type.Object({
      id: Type.String({ format: "uuid" }),
      position: Type.Integer({ minimum: 0 }),
    }),
    { minItems: 1 }
  ),
});
export type ReorderRolesDto = Static<typeof reorderRolesDto>;
