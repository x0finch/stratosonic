import type { Context } from "hono";
import { encryptPassword } from "../auth/crypto";
import { requireFreshSession, requirePermission, requireSession } from "../console-auth/middleware";
import { database } from "../db";
import { deleteSubsonicUser } from "../users/delete";
import {
  createUser,
  isUserNameConflict,
  listUsers,
  MAX_USER_LIBRARIES,
  setUserPassword,
  type UserChanges,
  type UserUpdateRefusal,
  type UserViewWithLibraries,
  updateUser,
  whyUpdateRefused,
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
 * - `GET /api/subsonic-users`: `200 {"users": SubsonicUserView[],
 *   "libraries": [{id, name}]}`, the users by name ignoring case, then id,
 *   and the active libraries a user may be given, by id, in one batch.
 * - `POST /api/subsonic-users`, `{username, password, isAdmin?, libraryIds?}`:
 *   `201 {"user": SubsonicUserView}`; `400 invalid_username`,
 *   `400 invalid_password`, `409 admin_required` (no admin exists and this
 *   is not one), `409 username_taken`, and the library refusals below.
 * - `PATCH /api/subsonic-users/:id`, `{username?, isAdmin?, libraryIds?}`,
 *   at least one: `200 {"user": SubsonicUserView}`; `400 invalid_username`,
 *   `404 not_found`, `409 last_admin`, `409 username_taken`, and the library
 *   refusals below.
 * - `PUT /api/subsonic-users/:id/password`, `{password}`: `200 {"ok": true}`;
 *   `400 invalid_password`, `404 not_found`.
 * - `DELETE /api/subsonic-users/:id`, `{}`: `200 {"ok": true}`, the user's
 *   playlists and their files deleted too (users/delete.ts);
 *   `404 not_found`, `409 last_admin`.
 *
 * **Libraries** (#84, "Per-user access", after Navidrome's
 * `core/library.go: SetUserLibraries` and `persistence/user_repository.go:
 * Put`). An admin has every library, and is given each, including the ones
 * connected later; a demoted admin keeps their rows. A new non-admin gets
 * the libraries marked `default_new_users`, unless `libraryIds` lists them.
 * Setting the list replaces it, in one batch. The refusals:
 *
 * - `400 libraries_required`: an empty list;
 * - `400 invalid_library`: an id that is unknown or being removed;
 * - `400 admin_has_all_libraries`: a list for a user who is, or stays, an
 *   admin (Navidrome: "cannot manually assign libraries to admin users").
 *
 * Auth reads a user's libraries on every request, so a change applies on
 * the next `/rest` call.
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
  /** How many playlists they own, which a delete would take with them. */
  readonly playlistCount: number;
  /** The active libraries their rows grant, by id: every one for an admin. */
  readonly libraryIds: readonly number[];
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
      const { users, libraries } = await listUsers(database(c.env));
      return c.json({ users: users.map(viewOf), libraries });
    },
  );

  api.post("/subsonic-users", ...write, async (c) => {
    const body = await readJsonObject(c);
    const { username, password, isAdmin = false, libraryIds } = body ?? {};
    if (typeof username !== "string" || typeof password !== "string") {
      return invalidRequest(c);
    }
    if (typeof isAdmin !== "boolean") {
      return invalidRequest(c);
    }
    const libraries = requestedLibraries(libraryIds);
    if (libraries === "invalid_request") {
      return invalidRequest(c);
    }

    const userName = acceptableUserName(username);
    if (userName === null) {
      return invalidUsername(c);
    }
    if (!isAcceptablePassword(password)) {
      return invalidPassword(c);
    }
    if (libraries === "libraries_required") {
      return librariesRefused(c, libraries);
    }
    if (libraries !== undefined && isAdmin) {
      return librariesRefused(c, "admin_has_all_libraries");
    }

    const ciphertext = await encryptPassword(c.var.passphrase, password);
    let created: Awaited<ReturnType<typeof createUser>>;
    try {
      created = await createUser(database(c.env), {
        userName,
        password: ciphertext,
        isAdmin,
        ...(libraries === undefined ? {} : { libraryIds: libraries }),
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
    if (created === "invalid_library") {
      return librariesRefused(c, created);
    }

    return c.json({ user: viewOf(created) }, 201);
  });

  api.patch("/subsonic-users/:id", ...write, async (c) => {
    const body = await readJsonObject(c);
    if (body === null) {
      return invalidRequest(c);
    }
    const { username, isAdmin, libraryIds } = body;
    const libraries = requestedLibraries(libraryIds);
    if (
      (username === undefined && isAdmin === undefined && libraryIds === undefined) ||
      (username !== undefined && typeof username !== "string") ||
      (isAdmin !== undefined && typeof isAdmin !== "boolean") ||
      libraries === "invalid_request"
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
    if (libraries === "libraries_required") {
      return librariesRefused(c, libraries);
    }
    if (libraries !== undefined) {
      if (isAdmin === true) {
        return librariesRefused(c, "admin_has_all_libraries");
      }
      changes.libraryIds = libraries;
    }

    const db = database(c.env);
    const id = c.req.param("id");
    let updated: UserViewWithLibraries | null;
    try {
      updated = await updateUser(db, id, changes);
    } catch (error) {
      if (isUserNameConflict(error)) {
        return usernameTaken(c);
      }
      throw error;
    }

    if (updated === null) {
      return refused(c, await whyUpdateRefused(db, id, changes));
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

function viewOf(row: UserViewWithLibraries): SubsonicUserView {
  return {
    id: row.id,
    username: row.userName,
    isAdmin: row.isAdmin,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastAccessAt: row.lastAccessAt?.toISOString() ?? null,
    playlistCount: row.playlistCount,
    libraryIds: row.libraryIds,
  };
}

/**
 * A request's `libraryIds`: absent (undefined), the distinct ids of a
 * non-empty list of positive integers, `"libraries_required"` for an empty
 * one, or `"invalid_request"` for anything else, a list longer than
 * `MAX_USER_LIBRARIES` included.
 */
function requestedLibraries(
  value: unknown,
): readonly number[] | undefined | "libraries_required" | "invalid_request" {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    !value.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0)
  ) {
    return "invalid_request";
  }
  const ids = [...new Set(value as number[])].sort((a, b) => a - b);
  if (ids.length === 0) {
    return "libraries_required";
  }
  return ids.length > MAX_USER_LIBRARIES ? "invalid_request" : ids;
}

function librariesRefused(
  c: Context,
  error: "libraries_required" | "invalid_library" | "admin_has_all_libraries",
) {
  return c.json({ error }, 400);
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

function refused(c: Context, refusal: UserUpdateRefusal) {
  switch (refusal) {
    case "not_found":
      return c.json({ error: "not_found" }, 404);
    case "last_admin":
      return c.json({ error: "last_admin" }, 409);
    default:
      return librariesRefused(c, refusal);
  }
}
