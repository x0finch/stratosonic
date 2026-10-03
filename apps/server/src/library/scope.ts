/**
 * Which libraries a read may see, and the SQL that keeps it to them (#84,
 * "Library access in the Subsonic API").
 *
 * Who sees what is Navidrome's (`persistence/sql_base_repository.go:
 * applyLibraryFilter`, `artist_repository.go:
 * applyLibraryFilterToArtistQuery`):
 *
 * - an admin sees every active library;
 * - anybody else sees the active libraries their `user_library` rows grant,
 *   and with none, nothing;
 * - **the fast path**, Navidrome's `userSeesAllLibraries`: a user who sees
 *   every library while none is `removing` gets no predicate at all. Every
 *   admin and every user of a one-library server therefore runs the SQL
 *   v0.5.0 ran, with no `library_id` in it.
 *
 * What a user sees is read with the user, in the statement that
 * authenticates them (`users/repository.ts: findUserByUsername`), so a
 * scope costs no round trip of its own.
 *
 * A scope narrows a read three ways:
 *
 * - a table with a `library_id` (albums, tracks) is kept to the scope's
 *   libraries (`libraryFilter`);
 * - an artist, which is shared and has no `library_id` (ADR-0009), is kept
 *   when one of its albums is in scope (`artistInScope`), and its
 *   `albumCount` and cover count only those albums (`albumOfArtistInScope`);
 * - search charges the scope's bound parameters to its budget
 *   (`scopeParameters`) before it fits words.
 *
 * D1 binds at most a hundred parameters a statement (d1-limits.ts), and an
 * artist read repeats its scope three times, so a scope of more than
 * `MAX_LISTED_LIBRARIES` ids is not listed: it becomes a subquery that
 * repeats the scope rule itself (`library.state = 'active'` and an admin or
 * an `exists` on `user_library`). Only a user's own scope can be that long,
 * since `musicFolderId` names at most `MAX_LISTED_LIBRARIES` libraries
 * (`library/libraries.ts: selectedLibraries`), so a narrowed scope is always
 * a list.
 */

import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { AuthenticatedUser } from "../auth/authenticate";

/**
 * The most library ids a scope lists as bound parameters; a longer scope is
 * a subquery. Also the most `musicFolderId` values a request may carry.
 */
export const MAX_LISTED_LIBRARIES = 20;

/** Whose scope rule a long scope repeats as a subquery. */
export interface ScopeViewer {
  readonly id: string;
  readonly isAdmin: boolean;
}

/**
 * The libraries a read may see: all of them, with no predicate (the fast
 * path), or these ids. `viewer` is the user whose rule a scope of more than
 * `MAX_LISTED_LIBRARIES` ids is read through; a scope without one (narrowed
 * by `musicFolderId`, or the console's one library) is always listed.
 */
export type LibraryScope =
  | { readonly all: true }
  | {
      readonly all: false;
      readonly ids: readonly number[];
      readonly viewer: ScopeViewer | null;
    };

/** The fast path: every library, and no predicate. */
export const ALL_LIBRARIES: LibraryScope = { all: true };

/** A scope of exactly these libraries, listed. */
export function librariesScope(ids: readonly number[]): LibraryScope {
  return { all: false, ids: [...new Set(ids)].sort((a, b) => a - b), viewer: null };
}

/**
 * A user's own scope, before any `musicFolderId` narrows it: every library
 * when they see every one and none is `removing`, otherwise the active
 * libraries they may see.
 */
export function scopeOf(user: AuthenticatedUser): LibraryScope {
  if (user.seesAllLibraries) {
    return ALL_LIBRARIES;
  }

  return { all: false, ids: user.libraryIds, viewer: { id: user.id, isAdmin: user.isAdmin } };
}

/**
 * The ids a scope is read through: a list of bound parameters, or for a long
 * user scope the subquery that repeats its rule. An empty scope is a list of
 * nothing, which SQLite reads as false.
 */
function scopeIds(scope: Exclude<LibraryScope, { all: true }>): SQL {
  if (scope.ids.length > MAX_LISTED_LIBRARIES && scope.viewer !== null) {
    return scope.viewer.isAdmin
      ? sql`(select l.id from library l where l.state = 'active')`
      : sql`(select l.id from library l where l.state = 'active'
          and exists (select 1 from user_library ul
            where ul.user_id = ${scope.viewer.id} and ul.library_id = l.id))`;
  }

  return sql`(${sql.join(
    scope.ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;
}

/**
 * `<column> in (...)` for a scoped read, or nothing on the fast path. The
 * column is a table's `library_id`, as Drizzle names it or, inside a
 * hand-written subquery, as raw SQL.
 */
export function libraryFilter(scope: LibraryScope, column: SQLWrapper): SQL | undefined {
  return scope.all ? undefined : sql`${column} in ${scopeIds(scope)}`;
}

/**
 * ` and album.library_id in (...)` for the hand-written subqueries over an
 * artist's albums (`artistColumns`), or nothing on the fast path, so those
 * subqueries read exactly as they did.
 */
export function albumOfArtistInScope(scope: LibraryScope): SQL {
  return scope.all ? sql`` : sql` and album.library_id in ${scopeIds(scope)}`;
}

/**
 * Keeps an artist that has an album in scope, or nothing on the fast path.
 * Artists are shared across libraries and carry no `library_id`; an artist
 * is in a library while one of its albums is (ADR-0009), which
 * `album_artist_id_idx` answers.
 */
export function artistInScope(scope: LibraryScope): SQL | undefined {
  return scope.all
    ? undefined
    : sql`exists (select 1 from album where album.artist_id = artist.id${albumOfArtistInScope(scope)})`;
}

/**
 * How many parameters one use of the scope binds: none on the fast path, an
 * id each for a list, and the user's id for a non-admin's subquery.
 */
export function scopeParameters(scope: LibraryScope): number {
  if (scope.all) {
    return 0;
  }
  if (scope.ids.length > MAX_LISTED_LIBRARIES && scope.viewer !== null) {
    return scope.viewer.isAdmin ? 0 : 1;
  }

  return scope.ids.length;
}
