import type { MutationOptions, QueryClient } from "@tanstack/react-query";

import {
  type Library,
  type LibraryName,
  type SubsonicUser,
  type SubsonicUserChanges,
  subsonicUsersQuery,
} from "@/lib/api";
import { LIBRARY_KEY } from "@/lib/overview";

/**
 * The rules of the Subsonic users page (`/users`, #82) that need no screen:
 * which refusal belongs to which field, when the **Subsonic admin** switch is
 * locked on, and what the dialogs say.
 */

/** The **Subsonic admin** switch's helper text, in the owner's words (#82). */
export const ADMIN_HELP =
  "Can start library scans and see and manage every user's playlists in Subsonic clients.";

/**
 * The refusals that belong to a field of the create and edit dialogs, by
 * the field's `name`. Every other one (`last_admin`, `admin_required`, …) is
 * a toast.
 */
export const USER_FIELDS_BY_CODE: Readonly<Record<string, string>> = {
  invalid_username: "username",
  username_taken: "username",
  invalid_password: "password",
  libraries_required: "libraries",
  invalid_library: "libraries",
};

/**
 * Whether a new user must be a Subsonic admin: while there is none, the
 * server refuses any other (`admin_required`), so the create dialog locks
 * the switch on and says why.
 */
export function adminRequired(users: readonly SubsonicUser[]): boolean {
  return !users.some((user) => user.isAdmin);
}

/**
 * What a PATCH sends: only what the edit dialog changed, or `null` when it
 * changed nothing and there is nothing to send. A rename to the same name in
 * another case is a change; the server allows it.
 *
 * `libraryIds`, where the dialog shows the Libraries field, goes only for a
 * user who is not, and does not become, a Subsonic admin, and only when it
 * differs from the libraries they have: an admin has every library, and the
 * server refuses a list for one (`admin_has_all_libraries`). A demoted
 * admin who keeps every box checked keeps their rows, as on the server.
 */
export function userChanges(
  user: SubsonicUser,
  edited: { username: string; isAdmin: boolean; libraryIds?: readonly number[] },
): SubsonicUserChanges | null {
  const changes: SubsonicUserChanges = {};
  // The server trims a name, so spaces around it change nothing.
  const username = edited.username.trim();
  if (username !== user.username) {
    changes.username = username;
  }
  if (edited.isAdmin !== user.isAdmin) {
    changes.isAdmin = edited.isAdmin;
  }
  if (
    edited.libraryIds !== undefined &&
    !edited.isAdmin &&
    !sameIds(edited.libraryIds, user.libraryIds)
  ) {
    changes.libraryIds = sortedIds(edited.libraryIds);
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

/* ----------------------------------------------------------- libraries -- */

/**
 * Whether the page shows libraries at all (#84, "Console"): only where more
 * than one exists, so a single-library server's page looks as it did, and
 * its writes send no `libraryIds`.
 */
export function showsLibraries(libraries: readonly LibraryName[]): boolean {
  return libraries.length > 1;
}

/** Ids in ascending order, each once, as the server keeps them. */
function sortedIds(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  const a = sortedIds(left);
  const b = sortedIds(right);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * The libraries a new user's field starts with: the assignable ones marked
 * "Give new Subsonic users access" (`defaultNewUsers`), as the server gives
 * a new user who names none. `known` is the Libraries page's list, which
 * only a role with `libraries:read` reads; without it the defaults are not
 * known here, and no box starts checked.
 */
export function defaultLibraryIds(
  assignable: readonly LibraryName[],
  known: readonly Pick<Library, "id" | "defaultNewUsers">[] | undefined,
): number[] {
  if (known === undefined) {
    return [];
  }
  const defaults = new Set(known.filter((entry) => entry.defaultNewUsers).map(({ id }) => id));
  return assignable.filter(({ id }) => defaults.has(id)).map(({ id }) => id);
}

/** The Libraries field's line for a Subsonic admin, in place of the boxes (#84). */
export const ADMIN_LIBRARIES = "Admins see every library.";

/** The Libraries field's error with no box checked (#84). */
export const LIBRARIES_REQUIRED = "Choose at least one library.";

/**
 * Why the Libraries field cannot be sent as it is, or `null` when it can:
 * a user who is not a Subsonic admin needs at least one library
 * (`libraries_required`). An admin's boxes are not shown, and not sent.
 */
export function librariesError(isAdmin: boolean, libraryIds: readonly number[]): string | null {
  return !isAdmin && libraryIds.length === 0 ? LIBRARIES_REQUIRED : null;
}

/**
 * The edit dialog's Libraries error: as `librariesError`, but only when the
 * edit would send the list (`userChanges`), so a user whose only library
 * was removed, and who so has none, can still be renamed with the boxes as
 * they were.
 */
export function editLibrariesError(
  user: SubsonicUser,
  edited: { isAdmin: boolean; libraryIds: readonly number[] },
): string | null {
  const changes = userChanges(user, { username: user.username, ...edited });
  return changes?.libraryIds === undefined
    ? null
    : librariesError(edited.isAdmin, edited.libraryIds);
}

/**
 * The add dialog's checked libraries: the owner's choice once they have
 * touched a box (`chosen`), and until then the defaults as they are now,
 * so defaults that arrive after the dialog opened (the Libraries page's
 * list still loading) are checked too.
 */
export function checkedLibraries(
  chosen: readonly number[] | null,
  defaults: readonly number[],
): readonly number[] {
  return chosen ?? defaults;
}

/**
 * The users table's Libraries cell (#84): "All" for a Subsonic admin,
 * otherwise the names of up to two, in id order, or "3 libraries" past two.
 * A user with none reads as the table's missing value.
 */
export function librariesLabel(
  user: Pick<SubsonicUser, "isAdmin" | "libraryIds">,
  libraries: readonly LibraryName[],
): string {
  if (user.isAdmin) {
    return "All";
  }
  const ids = new Set(user.libraryIds);
  const names = libraries.filter(({ id }) => ids.has(id)).map(({ name }) => name);
  if (names.length === 0) {
    return "—";
  }
  return names.length > 2 ? `${names.length.toLocaleString("en")} libraries` : names.join(", ");
}

/**
 * What a delete removes besides the user, as the owner decided it (#82, open
 * question 1): what the foreign keys cascade, and the user's playlists with
 * their `.m3u` files in the bucket. `playlists` is the number they own, as
 * the users API counts them.
 *
 * A playlist the scan imported from the bucket (an `.m3u` uploaded with
 * rclone, or migrated from Navidrome) belongs to whoever was the first
 * Subsonic admin when it was imported, so deleting that user deletes those
 * files too: the sentence says so wherever playlists may go.
 */
export function deleteConsequences(playlists: number): string {
  const annotations = "Their stars, ratings, play counts, bookmarks and play queue are deleted";
  const imported =
    "That count includes any playlists the scan imported from the bucket while they were the first Subsonic admin.";
  if (playlists === 0) {
    return `${annotations}. They have no playlists.`;
  }
  if (playlists === 1) {
    return `${annotations}, and their 1 playlist is deleted too, including its playlist file in the bucket. ${imported}`;
  }
  return `${annotations}, and their ${playlists.toLocaleString("en")} playlists are deleted too, including the playlist files in the bucket. ${imported}`;
}

/**
 * After every write to a Subsonic user, whether it went through or not: the
 * list is read again (#82's polling table), so a refusal over a stale list,
 * such as a user deleted in another tab, shows the list as it is. The
 * Overview's library, whose playlists name their owners, is marked stale
 * too (a rename changes those names, and a delete takes the user's
 * playlists with it), and is read again only when it is on screen.
 */
export function afterUserWrite(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: subsonicUsersQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: LIBRARY_KEY }),
  ]).then(() => undefined);
}

/** How a user write tells what it did: the page's toasts (lib/toasts.ts). */
export interface UserWriteNotices {
  success(title: string, description: string): void;
  error(error: unknown): void;
}

/**
 * The options of a user write's mutation. The outcome's toast and the
 * re-read are the mutation's own, which TanStack Query runs however the
 * write ends: a callback passed to `mutate` runs only while the component
 * that called it is mounted, so a dialog closed mid-write would lose them.
 * That per-call callback is left only what needs the dialog: closing it,
 * and showing a refusal beside its field.
 *
 * `fieldShown` says whether the dialog will show a refusal beside a field,
 * which then raises no toast; a dialog that is gone shows none, and the
 * refusal is a toast after all. It is asked once the re-read is done: Query
 * runs the per-call callbacks only after `onSettled` settles, so a dialog
 * that closes during the re-read would otherwise lose the refusal.
 */
export function userWriteOptions<TData, TVariables>(
  queryClient: QueryClient,
  notices: UserWriteNotices,
  write: {
    mutationFn: (variables: TVariables) => Promise<TData>;
    succeeded: (data: TData, variables: TVariables) => { title: string; description: string };
    fieldShown?: (error: unknown) => boolean;
  },
): MutationOptions<TData, unknown, TVariables> {
  return {
    mutationFn: write.mutationFn,
    // A create or a new password carries the password: the mutation cache
    // drops it as soon as nothing shows the write, not five minutes later.
    gcTime: 0,
    onSuccess: (data, variables) => {
      const { title, description } = write.succeeded(data, variables);
      notices.success(title, description);
    },
    onSettled: async (_data, error) => {
      await afterUserWrite(queryClient);
      if (error && !write.fieldShown?.(error)) {
        notices.error(error);
      }
    },
  };
}

/**
 * Whether two names are one to the server: equal but for ASCII case, as
 * the unique index on `lower(user_name)` and Subsonic sign-in compare them
 * (apps/server users/repository.ts, `userNamesMatch`).
 */
export function userNamesMatch(left: string, right: string): boolean {
  const fold = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return fold(left) === fold(right);
}

/** A day, for the table's Created column, in the browser's locale and zone. */
export function formatDay(iso: string, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(new Date(iso));
}
