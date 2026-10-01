/**
 * What a console user may do (#99): the permissions, and the roles that grant
 * them. The one place either is defined.
 *
 * Authorization asks for a permission, never for a role by name
 * (`requirePermission`, console-auth/middleware.ts). A role is only a named
 * set of permissions, so adding a role, or moving a permission between roles,
 * changes this map and no route.
 *
 * There is one role for now, `owner`, which grants every permission; the
 * database allows at most one owner (schema.ts). Each console user has
 * exactly one role, in `user.role`.
 *
 * A role this map does not know, one the database holds anyway (written by a
 * newer release, or by hand), grants nothing: failing closed means a typo or a
 * downgrade can lock a console user out, but can never let one do more than
 * intended. The way back is by hand in D1: fix the row's role, or delete the
 * console users (`user` rows), since setup reopens, with a new setup token,
 * only once none is left (apps/server/README.md).
 */

/**
 * Every permission, including the ones only later phases' routes will ask for
 * (#82), so that roles can be defined against the whole list from the start.
 */
export const PERMISSIONS = [
  // Change one's own console password (`POST /api/account/password`).
  "account:change-password",
  // See and manage Subsonic users (Phase 1, #82).
  "subsonic-users:read",
  "subsonic-users:write",
  // See the library overview: counts, genres, recent albums, playlists and
  // the scan's status (Phase 1, #82).
  "library:read",
  // See who is listening to what. Apart from `library:read` because it is
  // about people, not the library (Phase 1, #82).
  "activity:read",
  // Start a library scan (Phase 1, #82).
  "library:scan",
  // See the Cloudflare account's free-tier usage (`GET /api/usage`, #82).
  "usage:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Each role, what the console calls it, and what it grants. */
export const ROLES = {
  owner: { label: "Owner", permissions: PERMISSIONS },
} as const satisfies Record<string, { label: string; permissions: readonly Permission[] }>;

export type Role = keyof typeof ROLES;

/** The role setup gives the first console user. */
export const OWNER_ROLE: Role = "owner";

/** Whether a stored role is one this release knows. */
export function isKnownRole(role: string): role is Role {
  return Object.hasOwn(ROLES, role);
}

/** The permissions a stored role grants: none for a role this release does not know. */
export function permissionsOf(role: string): readonly Permission[] {
  return isKnownRole(role) ? ROLES[role].permissions : [];
}

/** Whether a stored role grants `permission`. */
export function roleGrants(role: string, permission: Permission): boolean {
  return permissionsOf(role).includes(permission);
}
