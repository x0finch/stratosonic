/**
 * The libraries a Subsonic client sees as music folders, and what it may say
 * about them with `musicFolderId` (#84, "Library access in the Subsonic
 * API").
 *
 * Navidrome calls a music folder a *library* and keeps a row per library
 * (model/library.go); so does Stratosonic since migration 0009 (ADR-0009).
 * A user sees the libraries authentication read with them
 * (auth/authenticate.ts), and everything that names a folder answers those:
 * `getMusicFolders`, and `getUser`'s `folder` list.
 */

import type { AuthenticatedUser } from "../auth/authenticate";
import { parseGoInt64 } from "../subsonic/params";
import { SubsonicError, SubsonicErrorCode } from "../subsonic/response";
import type { AuthenticatedSubsonicRequest } from "../subsonic/router";
import {
  ALL_LIBRARIES,
  type LibraryScope,
  librariesScope,
  MAX_LISTED_LIBRARIES,
  scopeOf,
} from "./scope";

/**
 * `<musicFolder>` for each library the user sees, Navidrome's
 * `GetMusicFolders`: id, then name, by id.
 */
export function musicFolderElements(
  user: AuthenticatedUser,
): { readonly id: number; readonly name: string }[] {
  return user.libraries.map(({ id, name }) => ({ id, name }));
}

/**
 * The libraries a request reads: the user's scope, narrowed by any
 * `musicFolderId`, Navidrome's `selectedMusicFolderIds`
 * (server/subsonic/helpers.go). The eight endpoints that take the parameter
 * call it: `getIndexes`, `getArtists`, `getAlbumList2`, `getStarred2`,
 * `getRandomSongs`, `getSongsByGenre`, `search2` and `search3`.
 *
 * - **A value that is not an integer is ignored**, not refused: Navidrome's
 *   `Ints` drops whatever `strconv.ParseInt` cannot read, and a request whose
 *   every value was dropped named no folder at all, which means the user's
 *   whole scope.
 * - **The parameter may repeat**, and every value is checked. More than
 *   `MAX_LISTED_LIBRARIES` values is error 0: a scope binds one parameter per
 *   library (library/scope.ts), which Navidrome, binding none, does not need
 *   to cap.
 * - **A library the user cannot see is error 70**, "Library N not found or
 *   not accessible", Navidrome's message, whether it exists or not.
 * - **Values narrow the scope, for admins too.** Values that name every
 *   library of a user who sees them all are no narrowing, and keep the fast
 *   path, as Navidrome's `searchScope` keeps it.
 *
 * Navidrome's `getIndexes` and `getArtists` swallow that error 70 and list
 * the user's whole scope (`browsing.go`). Stratosonic answers it on all
 * eight endpoints, deliberately: a client that asks for a folder it cannot
 * see has asked for something that is not there, and the whole scope
 * instead would show it music it did not ask for.
 */
export function selectedLibraries(request: AuthenticatedSubsonicRequest): LibraryScope {
  const { user } = request;
  const values = request.params
    .getAll("musicFolderId")
    .map(parseGoInt64)
    .filter((value) => value !== null);

  if (values.length > MAX_LISTED_LIBRARIES) {
    throw new SubsonicError(
      SubsonicErrorCode.Generic,
      `too many music folders: ${values.length}, at most ${MAX_LISTED_LIBRARIES} per request`,
    );
  }

  // Compared as bigints, so an id past 2^53 cannot round onto a real one.
  const visible = new Set(user.libraryIds.map(BigInt));
  for (const value of values) {
    if (!visible.has(value)) {
      throw new SubsonicError(
        SubsonicErrorCode.NotFound,
        `Library ${value} not found or not accessible`,
      );
    }
  }

  if (values.length === 0) {
    return scopeOf(user);
  }

  const selected = new Set(values.map(Number));
  if (user.seesAllLibraries && user.libraryIds.every((id) => selected.has(id))) {
    return ALL_LIBRARIES;
  }

  return librariesScope([...selected]);
}
