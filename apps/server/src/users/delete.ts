import type { Database } from "../db";
import type { Env } from "../env";
import { erasePlaylistFiles } from "../playlists/writes";
import { checkUserDeletion, deleteUserRows, type UserRefusal, whyRefused } from "./repository";

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
 *    delete is written with) and which `.m3u` files they own. A refused
 *    delete stops here, having touched no object.
 * 2. **The files** go, in one R2 binding call (`erasePlaylistFiles`). A
 *    failure throws, and the API answers 500 with the user and every row in
 *    place: the same delete can simply be tried again.
 * 3. **The rows** go in one guarded D1 batch (`deleteUserRows`): the user,
 *    with what cascades from them, and their playlists with their entries.
 *
 * Files before rows is ADR-0006's rule for a playlist delete, `erasePlaylist`:
 * whatever fails between the two leaves rows whose files are gone, which the
 * next import's sweep removes (it deletes the rows of a listed stretch whose
 * key the bucket no longer holds), never files without rows, which it would
 * import again. Rows before files would make an R2 failure resurrect every
 * playlist.
 *
 * What the order leaves to a race, and why each outcome is one the next
 * import gets right:
 *
 * - The batch fails (a 500), or finds the user became the last admin after
 *   the check (another admin demoted or deleted in between; a `409
 *   last_admin` then, or `404 not_found` if the user went too): the files
 *   are gone, the user and their playlist rows stay, and the next pass of
 *   the import sweeps those rows.
 * - The user creates a playlist through `/rest` between the check and the
 *   batch: the batch deletes its row (it deletes by owner, not by the keys
 *   read), its file stays, and the next import brings it back owned by the
 *   first admin, which is what Navidrome's cascade does to a playlist
 *   synced from a file.
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

  await erasePlaylistFiles(env, check.playlistKeys);

  if (await deleteUserRows(db, id)) {
    return null;
  }

  return whyRefused(db, id);
}
