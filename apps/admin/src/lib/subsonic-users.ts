import type { QueryClient } from "@tanstack/react-query";

import { type SubsonicUser, subsonicUsersQuery } from "@/lib/api";

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
 */
export function userChanges(
  user: SubsonicUser,
  edited: { username: string; isAdmin: boolean },
): { username?: string; isAdmin?: boolean } | null {
  const changes: { username?: string; isAdmin?: boolean } = {};
  if (edited.username !== user.username) {
    changes.username = edited.username;
  }
  if (edited.isAdmin !== user.isAdmin) {
    changes.isAdmin = edited.isAdmin;
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

/**
 * What a delete removes besides the user, as the owner decided it (#82, open
 * question 1): what the foreign keys cascade, and the user's playlists with
 * their `.m3u` files in the bucket. `playlists` is the number they own, or
 * `undefined` when the console cannot know it.
 */
export function deleteConsequences(playlists: number | undefined): string {
  const annotations = "Their stars, ratings, play counts, bookmarks and play queue are deleted";
  if (playlists === undefined) {
    return `${annotations}, and their playlists are deleted too, including the playlist files in the bucket.`;
  }
  if (playlists === 0) {
    return `${annotations}. They have no playlists.`;
  }
  if (playlists === 1) {
    return `${annotations}, and their 1 playlist is deleted too, including its playlist file in the bucket.`;
  }
  return `${annotations}, and their ${playlists.toLocaleString("en")} playlists are deleted too, including the playlist files in the bucket.`;
}

/**
 * The Overview's library read (`GET /api/overview/library`), whose playlists
 * name their owners: a rename changes those names, and a delete takes the
 * user's playlists with it.
 */
const LIBRARY_QUERY_KEY = ["overview", "library"] as const;

/**
 * After every write to a Subsonic user, whether it went through or not: the
 * list is read again (#82's polling table), so a refusal over a stale list,
 * such as a user deleted in another tab, shows the list as it is. The
 * Overview's library is marked stale too, and is read again only when it is
 * on screen.
 */
export function afterUserWrite(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: subsonicUsersQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: LIBRARY_QUERY_KEY }),
  ]).then(() => undefined);
}

/** What this page reads of the Overview's library: each playlist's owner, by name. */
interface LibraryPlaylists {
  playlists: readonly { owner: string | null }[];
}

/**
 * How many playlists `username` owns, from the Overview's library read when
 * the console already holds it (#82: "N comes from the list already loaded;
 * there is no extra query"). `undefined` when it holds none, or only one a
 * user write has made stale, such as a rename since: the delete dialog then
 * names no number rather than a wrong one.
 */
export function playlistCountFrom(queryClient: QueryClient, username: string): number | undefined {
  const state = queryClient.getQueryState<LibraryPlaylists>(LIBRARY_QUERY_KEY);
  if (!state?.data || state.isInvalidated || !Array.isArray(state.data.playlists)) {
    return undefined;
  }
  return state.data.playlists.filter((playlist) => playlist.owner === username).length;
}

/** A day, for the table's Created column, in the browser's locale and zone. */
export function formatDay(iso: string, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(new Date(iso));
}

/**
 * When a Subsonic client last signed in as the user, for the Last access
 * column: "Never" for a user no client has used yet.
 */
export function formatLastAccess(iso: string | null, locale?: string, timeZone?: string): string {
  if (iso === null) {
    return "Never";
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(iso));
}
