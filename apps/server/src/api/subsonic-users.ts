import type { Context } from "hono";
import { encryptPassword } from "../auth/crypto";
import { requireFreshSession, requirePermission, requireSession } from "../console-auth/middleware";
import { database } from "../db";
import { deleteSubsonicUser } from "../users/delete";
import {
  createUser,
  isUserNameConflict,
  listUsers,
  setUserPassword,
  type UserChanges,
  type UserRefusal,
  type UserViewRow,
  updateUser,
  whyRefused,
} from "../users/repository";
import { acceptableUserName, isAcceptablePassword } from "../users/validation";
import type { ApiApp } from "./app";
import { invalidRequest, limitJsonBody, readJsonObject } from "./json-body";
import { requireSameOrigin } from "./same-origin";

/**
 * Managing Subsonic users from the console (#82, "API: Subsonic users"; #115).
 *
 * A Subsonic user is an account a Subsonic client signs in as, never one that
 * signs in to the console (#99), so Navidrome's self-service rules (a user
 * edits only themselves, and gives their current password) do not apply: the
 * console user managing them is never one of them. Navidrome's
 * `validatePasswordChange` skips the current password the same way when an
 * admin sets another user's (persistence/user_repository.go).
 *
 * Subsonic auth reads `subsonic_user` on every request and keeps no copy
 * (auth/authenticate.ts), so a new password, a rename, a demotion or a delete
 * takes effect on the next `/rest` call.
 *
 * Reads need a session, which the cookie cache may vouch for, and
 * `subsonic-users:read`. Writes go through `requireSameOrigin`,
 * `limitJsonBody`, `requireFreshSession` (D1, past the cookie cache) and
 * `subsonic-users:write`, in that order, as in api/account.ts; each sends a
 * JSON object, `{}` for a delete. The answers:
 *
 * - `GET /api/subsonic-users`: `200 {"users": SubsonicUserView[]}`, by name
 *   ignoring case, then id.
 * - `POST /api/subsonic-users`, `{username, password, isAdmin?}`:
 *   `201 {"user": SubsonicUserView}`; `400 invalid_username`,
 *   `400 invalid_password`, `409 admin_required` (no admin exists and this
 *   is not one), `409 username_taken`.
 * - `PATCH /api/subsonic-users/:id`, `{username?, isAdmin?}`, at least one:
 *   `200 {"user": SubsonicUserView}`; `400 invalid_username`,
 *   `404 not_found`, `409 last_admin`, `409 username_taken`.
 * - `PUT /api/subsonic-users/:id/password`, `{password}`: `200 {"ok": true}`;
 *   `400 invalid_password`, `404 not_found`.
 * - `DELETE /api/subsonic-users/:id`, `{}`: `200 {"ok": true}`, the user's
 *   playlists and their files deleted too (users/delete.ts);
 *   `404 not_found`, `409 last_admin`.
 *
 * A body that is not a JSON object, or a field of the wrong type, is
 * `400 invalid_request`. A refusal writes nothing.
 */

/** A Subsonic user as the console sees one. It never carries a password. */
export interface SubsonicUserView {
  readonly id: string;
  readonly username: string;
  readonly isAdmin: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastAccessAt: string | null;
}

export function registerSubsonicUserRoutes(api: ApiApp): void {
  const write = [
    requireSameOrigin,
    limitJsonBody,
    requireFreshSession,
    requirePermission("subsonic-users:write"),
  ] as const;

  api.get(
    "/subsonic-users",
    requireSession,
    requirePermission("subsonic-users:read"),
    async (c) => {
      const users = await listUsers(database(c.env));
      return c.json({ users: users.map(viewOf) });
    },
  );

  api.post("/subsonic-users", ...write, async (c) => {
    const body = await readJsonObject(c);
    const { username, password, isAdmin = false } = body ?? {};
    if (typeof username !== "string" || typeof password !== "string") {
      return invalidRequest(c);
    }
    if (typeof isAdmin !== "boolean") {
      return invalidRequest(c);
    }

    const userName = acceptableUserName(username);
    if (userName === null) {
      return invalidUsername(c);
    }
    if (!isAcceptablePassword(password)) {
      return invalidPassword(c);
    }

    const ciphertext = await encryptPassword(c.var.passphrase, password);
    let created: Awaited<ReturnType<typeof createUser>>;
    try {
      created = await createUser(database(c.env), {
        userName,
        password: ciphertext,
        isAdmin,
      });
    } catch (error) {
      if (isUserNameConflict(error)) {
        return usernameTaken(c);
      }
      throw error;
    }

    if (created === "admin_required") {
      return c.json({ error: "admin_required" }, 409);
    }

    return c.json({ user: viewOf(created) }, 201);
  });

  api.patch("/subsonic-users/:id", ...write, async (c) => {
    const body = await readJsonObject(c);
    if (body === null) {
      return invalidRequest(c);
    }
    const { username, isAdmin } = body;
    if (
      (username === undefined && isAdmin === undefined) ||
      (username !== undefined && typeof username !== "string") ||
      (isAdmin !== undefined && typeof isAdmin !== "boolean")
    ) {
      return invalidRequest(c);
    }

    const changes: { -readonly [K in keyof UserChanges]: UserChanges[K] } = {};
    if (username !== undefined) {
      const userName = acceptableUserName(username);
      if (userName === null) {
        return invalidUsername(c);
      }
      changes.userName = userName;
    }
    if (isAdmin !== undefined) {
      changes.isAdmin = isAdmin;
    }

    const db = database(c.env);
    const id = c.req.param("id");
    let updated: UserViewRow | null;
    try {
      updated = await updateUser(db, id, changes);
    } catch (error) {
      if (isUserNameConflict(error)) {
        return usernameTaken(c);
      }
      throw error;
    }

    if (updated === null) {
      return refused(c, await whyRefused(db, id));
    }

    return c.json({ user: viewOf(updated) });
  });

  api.put("/subsonic-users/:id/password", ...write, async (c) => {
    const body = await readJsonObject(c);
    const { password } = body ?? {};
    if (typeof password !== "string") {
      return invalidRequest(c);
    }
    if (!isAcceptablePassword(password)) {
      return invalidPassword(c);
    }

    const ciphertext = await encryptPassword(c.var.passphrase, password);
    if (!(await setUserPassword(database(c.env), c.req.param("id"), ciphertext))) {
      return refused(c, "not_found");
    }

    return c.json({ ok: true });
  });

  api.delete("/subsonic-users/:id", ...write, async (c) => {
    if ((await readJsonObject(c)) === null) {
      return invalidRequest(c);
    }

    const refusal = await deleteSubsonicUser(c.env, database(c.env), c.req.param("id"));
    if (refusal !== null) {
      return refused(c, refusal);
    }

    return c.json({ ok: true });
  });
}

function viewOf(row: UserViewRow): SubsonicUserView {
  return {
    id: row.id,
    username: row.userName,
    isAdmin: row.isAdmin,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastAccessAt: row.lastAccessAt?.toISOString() ?? null,
  };
}

function invalidUsername(c: Context) {
  return c.json({ error: "invalid_username" }, 400);
}

function invalidPassword(c: Context) {
  return c.json({ error: "invalid_password" }, 400);
}

function usernameTaken(c: Context) {
  return c.json({ error: "username_taken" }, 409);
}

function refused(c: Context, refusal: UserRefusal) {
  return refusal === "not_found"
    ? c.json({ error: "not_found" }, 404)
    : c.json({ error: "last_admin" }, 409);
}
