import { DEFAULT_LIBRARY_ID } from "@stratosonic/db";
import type { Database } from "../db";
import type { Env } from "../env";
import { deletePlaylistRowsByKeys, type LibraryKeys } from "../playlists/repository";
import { erasePlaylistFiles } from "../playlists/writes";
import { bindingStorage } from "../storage/binding";
import { storageFor } from "../storage/for-library";
import type { LibraryStorage } from "../storage/storage";
import {
  checkUserDeletion,
  deleteUserRows,
  type PlaylistFilesLibrary,
  type UserRefusal,
  whyRefused,
} from "./repository";

/**
 * Deleting a Subsonic user from the console (#82, "API: Subsonic users", and
 * the owner's decision on its open question 1): the user goes, and so do
 * their playlists, `.m3u` files and all, as Navidrome cascades a deleted
 * user's playlists (`playlist_user_user_id_fk ... on delete cascade`). The
 * bucket is the source of truth for playlists (ADR-0006), so leaving the
 * files would only bring the playlists back on the next import, owned by the
 * first admin.
 *
 * ## The order: check, files, rows
 *
 * 1. **A guarded check** reads, in one round trip, whether the user exists
 *    and may be deleted (not the last admin, by the same condition the
 *    delete is written with), and which `.m3u` files they own, in which
 *    libraries; then, only for files outside library 1, those libraries'
 *    rows. A refused delete stops here, having touched no object.
 * 2. **The files** go, library by library, through each library's own
 *    storage (#84, "Playlists across libraries"): one call per library per
 *    thousand keys (`erasePlaylistFiles`), library 1's through the binding.
 *    A failure throws, and the API answers 500 with the user and every row
 *    in place: the same delete can simply be tried again.
 * 3. **The rows** go in one guarded D1 batch (`deleteUserRows`): the user,
 *    with what cascades from them, and their playlists with their entries.
 *
 * A file in a library that is read-only, or no longer active, is not
 * deleted: the library's last test says its bucket refuses writes, and a
 * delete that always failed would make the user impossible to delete. Its
 * row still goes, and the next import brings the playlist back owned by the
 * first admin, which is what Navidrome's cascade does to a playlist synced
 * from a file (its files are never deleted). In practice such a playlist was
 * imported, since a client's new playlist is written to library 1.
 *
 * Files before rows is ADR-0006's rule for a playlist delete, `erasePlaylist`:
 * whatever fails between the two leaves rows whose files are gone, which the
 * next import's sweep removes (it deletes the rows of a listed stretch whose
 * key the bucket no longer holds), never files without rows, which it would
 * import again. Rows before files would make a storage failure resurrect
 * every playlist.
 *
 * What the order leaves to a race, and why each outcome is one the next
 * import gets right:
 *
 * - The batch finds the user became the last admin after the check (two
 *   console requests racing: both admins deleted at once, or one deleted
 *   while the other is demoted; a `409 last_admin` then, or `404 not_found`
 *   if the user went too): the files are gone and the user stays. The rows
 *   of the erased files are deleted at once (`deletePlaylistRowsByKeys`),
 *   so D1 matches the buckets without waiting for the import's sweep, and
 *   the loss is logged, since that user's playlists are gone.
 * - The batch fails (a 500): the files are gone, the user and their
 *   playlist rows stay, and the next pass of the import sweeps those rows.
 * - A client writes one of the user's playlists through `/rest` between the
 *   storage delete and the batch: `createPlaylist` puts a new file, and
 *   `updatePlaylist`, or any other write of an existing playlist, puts its
 *   file back under the same key. The batch deletes the row (it deletes by
 *   owner, not by the keys read), the file stays, and the next import
 *   brings the playlist back owned by the first admin, which is what
 *   Navidrome's cascade does to a playlist synced from a file.
 * - An import already reading one of the files when it is deleted may write
 *   its row again after the batch, owned by the deleted user's id; the next
 *   pass sweeps it, the file being gone.
 */
export async function deleteSubsonicUser(
  env: Env,
  db: Database,
  id: string,
): Promise<UserRefusal | null> {
  const check = await checkUserDeletion(db, id);
  if (check.refusal !== null) {
    return check.refusal;
  }

  const erased: LibraryKeys[] = [];
  for (const { libraryId, keys } of byLibrary(check.playlistFiles)) {
    const storage = playlistFilesStorage(env, libraryId, check.libraries.get(libraryId));
    if (storage === null) {
      console.warn(
        `subsonic users: deleting ${id} leaves ${keys.length} playlist files in library ${libraryId}, which is not writable`,
      );
      continue;
    }
    await erasePlaylistFiles(storage, keys);
    erased.push({ libraryId, keys });
  }

  if (await deleteUserRows(db, id)) {
    return null;
  }

  // Refused after the files went: a race the check could not see (above).
  const count = erased.reduce((total, { keys }) => total + keys.length, 0);
  if (count > 0) {
    console.warn(
      `subsonic users: deleting ${id} was refused after ${count} playlist files were erased; removing their rows`,
    );
    await deletePlaylistRowsByKeys(db, erased);
  }

  return whyRefused(db, id);
}

/** The files, by library in ascending id, each library's keys in the order they came. */
function byLibrary(
  files: readonly { readonly libraryId: number; readonly r2Key: string }[],
): LibraryKeys[] {
  const grouped = new Map<number, string[]>();
  for (const { libraryId, r2Key } of files) {
    const keys = grouped.get(libraryId) ?? [];
    grouped.set(libraryId, keys);
    keys.push(r2Key);
  }

  return [...grouped]
    .sort(([left], [right]) => left - right)
    .map(([libraryId, keys]) => ({ libraryId, keys }));
}

/**
 * The storage a library's playlist files are deleted through: the binding
 * for library 1, the row's for another, or null for one that is not
 * writable, not active, or gone.
 */
function playlistFilesStorage(
  env: Env,
  libraryId: number,
  row: PlaylistFilesLibrary | undefined,
): LibraryStorage | null {
  if (libraryId === DEFAULT_LIBRARY_ID) {
    return bindingStorage(env);
  }
  if (row === undefined || row.state !== "active" || !row.writable) {
    return null;
  }

  return storageFor(env, row);
}
