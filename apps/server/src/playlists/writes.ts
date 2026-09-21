/**
 * Writing a playlist back to the bucket: what `createPlaylist` and
 * `deletePlaylist` do underneath.
 *
 * ## The file is written first, and the row is the importer's
 *
 * R2 holds the playlists; D1 only indexes them (ADR-0006). So a client write
 * puts the `.m3u` and *then* writes the row, with the id derived from the key
 * by `playlistId` and the row built by the importer's own upsert statements.
 * Two consequences are the point of doing it this way:
 *
 * - The next cron pass reads the file that was just written and writes the
 *   same row again - same id, same name, same order, same `created` and
 *   `changed` - so a client write and an import converge instead of fighting.
 * - A failure between the two leaves an `.m3u` with no row, which the next
 *   pass imports, rather than a row with no file, which the sweep would
 *   delete and the listener would watch vanish.
 *
 * The timestamps come from the object R2 has just stored, not from our clock,
 * because that is what every later import will stamp the row with.
 *
 * ## The key is a random id, not the name
 *
 * A new playlist's file is `playlists/<random id>.m3u`. Naming it after the
 * playlist would make two playlists called "Mix" one file - the second create
 * silently overwriting the first - and would tie the id, which is the hash of
 * the key, to a name a listener may change tomorrow. The name lives in the
 * file's `#PLAYLIST:` line, where the parser already reads it from.
 */

import { newRandomId, playlistId } from "@stratosonic/db";
import type { Database } from "../db";
import type { Env } from "../env";
import { playlistNameForFile, renderM3u } from "./m3u";
import {
  deletePlaylistRow,
  type EntryTrack,
  type ImportedPlaylist,
  runBatch,
  upsertPlaylistStatements,
} from "./repository";

/** Where the playlists a client writes live, beside the ones rclone uploads. */
export const CLIENT_PLAYLIST_PREFIX = "playlists/";

/** The key a new playlist's file takes: a random id under that prefix. */
export function newPlaylistKey(): string {
  return `${CLIENT_PLAYLIST_PREFIX}${newRandomId()}.m3u`;
}

/** A playlist as a client write leaves it: the whole file, every time. */
export interface PlaylistWrite {
  /**
   * Whether the `comment` and `public` passed here replace what the row
   * holds. `updatePlaylist` says yes - changing them may be the whole point
   * of the call - and the other writes pass what they read, so it makes no
   * difference to them. An import never says yes: neither lives in the
   * `.m3u`, so re-reading the file is no reason to touch either.
   */
  readonly writesDetails?: boolean;
  /** The `.m3u` to write. An existing playlist keeps its key, and so its id. */
  readonly r2Key: string;
  readonly name: string;
  readonly comment: string;
  readonly ownerId: string;
  readonly public: boolean;
  /** When the playlist first appeared, or null when it is appearing now. */
  readonly createdAt: Date | null;
  /** The tracks it holds, in order, duplicates and all. */
  readonly tracks: readonly EntryTrack[];
}

/**
 * Puts the `.m3u` and then writes the row it implies. Answers with the id,
 * which is the hash of the key either way, so the caller does not have to
 * know whether the playlist existed.
 */
export async function writePlaylist(env: Env, db: Database, write: PlaylistWrite): Promise<string> {
  const name = playlistNameForFile(write.name);
  const text = renderM3u(
    name,
    write.tracks.map((entry) => entry.r2Key),
  );

  const object = await env.MUSIC.put(write.r2Key, new TextEncoder().encode(text));
  if (object === null) {
    // R2 refused the write. Nothing goes to D1: a row whose file does not
    // exist is the one state this order exists to avoid.
    throw new Error(`playlists: R2 refused ${write.r2Key}`);
  }

  const imported: ImportedPlaylist = {
    id: playlistId(write.r2Key),
    name,
    comment: write.comment,
    ownerId: write.ownerId,
    public: write.public,
    songCount: write.tracks.length,
    duration: write.tracks.reduce((total, entry) => total + entry.duration, 0),
    r2Key: write.r2Key,
    // The object's own clock, as the import reads it, so the next pass over
    // this untouched file changes nothing a client can see.
    createdAt: write.createdAt ?? object.uploaded,
    changedAt: object.uploaded,
    trackIds: write.tracks.map((entry) => entry.id),
  };

  await runBatch(
    db,
    upsertPlaylistStatements(db, imported, { writesDetails: write.writesDetails ?? false }),
  );

  return imported.id;
}

/**
 * Removes a playlist's file and then its row.
 *
 * That order again, for the same reason read the other way: a crash in
 * between leaves a row whose file has gone, which the next sweep removes. The
 * other order would leave an `.m3u` the next pass imports, and a listener
 * would watch a playlist they deleted come back.
 */
export async function erasePlaylist(
  env: Env,
  db: Database,
  id: string,
  r2Key: string,
): Promise<void> {
  await env.MUSIC.delete(r2Key);
  await deletePlaylistRow(db, id);
}
