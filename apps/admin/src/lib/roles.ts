import type { Me } from "@/lib/api";

/**
 * What the console calls each role the server knows (its
 * `console-auth/permissions.ts`), for nav-user's second line. `owner` is the
 * only one for now.
 */
const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
};

/** A role's label, or the role itself for one this console has no words for. */
export function roleLabel(role: string): string {
  return Object.hasOwn(ROLE_LABELS, role) ? (ROLE_LABELS[role] ?? role) : role || "No role";
}

/**
 * Whether the signed-in console user's role grants a permission, as the server
 * says in `GET /api/me`. It only decides what the console offers: every route
 * checks the permission itself.
 */
export function can(me: Me | null | undefined, permission: string): boolean {
  return me?.permissions.includes(permission) ?? false;
}
