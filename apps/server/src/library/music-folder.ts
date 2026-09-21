/**
 * The one music folder Stratosonic serves, and what a client may say about it.
 *
 * Navidrome calls a music folder a *library* and keeps a row per library; a
 * fresh install has exactly one, `model.DefaultLibraryID` = 1 named
 * `model.DefaultLibraryName` = "Music Library" (model/library.go). Stratosonic
 * serves one R2 bucket as one library and will never have a second, so those
 * two defaults are constants here. Everything that names the folder uses them:
 * `getUser`'s `folder` list, and `getMusicFolders`.
 */

import { SubsonicError, SubsonicErrorCode } from "../subsonic/response";

/** The id of the only music folder, matching Navidrome's default library. */
export const MUSIC_FOLDER_ID = 1;

/**
 * Its name, as a client shows it in a folder picker. This is Navidrome's
 * default library name rather than the R2 bucket's own name: the bucket name
 * is a deployment detail — it differs between the account, the preview and
 * the test bindings — and letting it through would make the folder a client
 * has already stored look like a different one after a redeploy.
 */
export const MUSIC_FOLDER_NAME = "Music Library";

/** `<musicFolder>`, Navidrome's `responses.MusicFolder`: id, then name. */
export function musicFolderElement(): { readonly id: number; readonly name: string } {
  return { id: MUSIC_FOLDER_ID, name: MUSIC_FOLDER_NAME };
}

/** Whole numbers, as Go's `strconv.ParseInt` with base 10 reads them. */
const INTEGER = /^[+-]?\d+$/;

/** The range of a Go `int64`; `ParseInt` fails outside it. */
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * Rejects a `musicFolderId` that does not name this library, the way
 * Navidrome's `selectedMusicFolderIds` does (server/subsonic/helpers.go): an
 * id the caller cannot reach is error 70, carrying that same message.
 *
 * Two quirks below are Navidrome's, kept so a client meets the same server
 * twice:
 *
 * - **A value that is not an integer is ignored**, not refused: its `Ints`
 *   helper drops whatever `strconv.ParseInt` cannot read, and a request whose
 *   every value was dropped counts as one that named no folder at all — which
 *   means the whole library.
 * - **The parameter may repeat**, and every occurrence is checked.
 *
 * The browsing endpoints call this even though the answer can only ever be
 * the one folder: a client that asks for a folder this server does not have
 * has asked for something that is not there, and serving the whole library
 * instead would show it music it did not ask for.
 */
export function checkMusicFolderIds(params: URLSearchParams): void {
  for (const value of params.getAll("musicFolderId")) {
    if (!INTEGER.test(value)) {
      continue;
    }

    const id = BigInt(value);
    if (id < INT64_MIN || id > INT64_MAX) {
      continue;
    }

    if (id !== BigInt(MUSIC_FOLDER_ID)) {
      throw new SubsonicError(
        SubsonicErrorCode.NotFound,
        `Library ${id} not found or not accessible`,
      );
    }
  }
}
