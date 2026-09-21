import { SubsonicError, SubsonicErrorCode } from "../subsonic/response";

/**
 * Stratosonic serves one R2 bucket as one library, so there is exactly one
 * music folder and it has this id. Everything that names the folder uses this
 * constant: `getUser`'s `folder` list today, and `getMusicFolders` when the
 * library lands.
 */
export const MUSIC_FOLDER_ID = 1;

/**
 * Rejects a `musicFolderId` that names a folder this server does not serve.
 *
 * Navidrome's `selectedMusicFolderIds` (server/subsonic/helpers.go) checks
 * every value the client sent against the libraries the user may see and
 * answers error 70 for the first one that is not among them; with no
 * `musicFolderId` at all it filters nothing. There is exactly one library
 * here, so a folder that is not it can only be a stale id from another server
 * — and "not found" is the honest answer, rather than quietly serving the
 * whole library the client tried to narrow.
 *
 * A value that is not an integer is skipped rather than rejected, as
 * Navidrome's `req.Params.Ints` skips it.
 */
export function checkMusicFolderIds(params: URLSearchParams): void {
  for (const value of params.getAll("musicFolderId")) {
    if (!/^[+-]?\d+$/.test(value)) {
      continue;
    }

    const id = Number(value);
    if (id !== MUSIC_FOLDER_ID) {
      throw new SubsonicError(
        SubsonicErrorCode.NotFound,
        `Library ${id} not found or not accessible`,
      );
    }
  }
}
