import type { MutationOptions, QueryClient } from "@tanstack/react-query";

import { type SubsonicUser, subsonicUsersQuery } from "@/lib/api";
import { libraryQuery } from "@/lib/overview";

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
  // The server trims a name, so spaces around it change nothing.
  const username = edited.username.trim();
  if (username !== user.username) {
    changes.username = username;
  }
  if (edited.isAdmin !== user.isAdmin) {
    changes.isAdmin = edited.isAdmin;
  }
  return Object.keys(changes).length > 0 ? changes : null;
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
    "This includes playlists the scan imported from the bucket while they were the first Subsonic admin.";
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
    queryClient.invalidateQueries({ queryKey: libraryQuery.queryKey }),
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
 * refusal is a toast after all.
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
    onSuccess: (data, variables) => {
      const { title, description } = write.succeeded(data, variables);
      notices.success(title, description);
    },
    onError: (error) => {
      if (!write.fieldShown?.(error)) {
        notices.error(error);
      }
    },
    onSettled: () => afterUserWrite(queryClient),
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
