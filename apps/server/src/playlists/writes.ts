/**
 * Writing a playlist back to its bucket: what `createPlaylist`,
 * `updatePlaylist` and `deletePlaylist` do underneath.
 *
 * ## The file is written first, and the row is the importer's
 *
 * The bucket holds the playlists; D1 only indexes them (ADR-0006). So a
 * client write puts the `.m3u` and *then* writes the row, with the id derived
 * from the library and the key by `playlistId` and the row built by the
 * importer's own upsert statements. Two consequences are the point of doing
 * it this way:
 *
 * - The next cron pass reads the file that was just written and writes the
 *   same row again - same id, same name, same order, same `created` and
 *   `changed` - so a client write and an import converge instead of fighting.
 * - A failure between the two leaves an `.m3u` with no row, which the next
 *   pass imports, rather than a row with no file, which the sweep would
 *   delete and the listener would watch vanish.
 *
 * The timestamps come from the object the bucket has just stored, not from
 * our clock, because that is what every later import will stamp the row with
 * (to the second, through S3: `matchesStoredPlaylist`).
 *
 * ## Which bucket (#84, "Playlists across libraries")
 *
 * A new playlist is written to **library 1**, the bound bucket (ADR-0006). An
 * existing one is written, and deleted, in **its own library**
 * (`playlistTarget`); a read-only library refuses before anything is put or
 * written. In the file, a track of the playlist's own library is its bare
 * key, so a playlist of library 1's tracks is byte for byte the file v0.5.0
 * wrote, and a track of another library is `<library path>/<key>`, which the
 * import reads back into that library (`playlistLine`, `entryCandidates`).
 *
 * The id never collides with another library's (ADR-0009's guard, in
 * `upsertPlaylistStatements`): an existing playlist keeps the id of the row
 * it was read with, in that row's library, and a new key is
 * `playlists/<random id>.m3u` in library 1, which no other library's id can
 * equal, since that needs a key beginning with digits and U+200B.
 *
 * ## The key is a random id, not the name
 *
 * A new playlist's file is `playlists/<random id>.m3u`. Naming it after the
 * playlist would make two playlists called "Mix" one file - the second create
 * silently overwriting the first - and would tie the id, which is the hash of
 * the key, to a name a listener may change tomorrow. The name lives in the
 * file's `#PLAYLIST:` line, where the parser already reads it from.
 */

import { DEFAULT_LIBRARY_ID, newRandomId, playlistId } from "@stratosonic/db";
import type { Database } from "../db";
import type { Env } from "../env";
import { bindingStorage } from "../storage/binding";
import { storageFor } from "../storage/for-library";
import type { LibraryStorage } from "../storage/storage";
import { playlistLine, playlistNameForFile, renderM3u } from "./m3u";
import {
  deletePlaylistRow,
  type EntryTrack,
  findLibraryPaths,
  findPlaylistLibrary,
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

/** Where a playlist's file is written: its library, and that library's bucket. */
export interface PlaylistTarget {
  readonly libraryId: number;
  readonly storage: LibraryStorage;
  /** Every library's path, when the target's row was read with them. */
  readonly paths?: ReadonlyMap<number, string>;
}

/** Library 1, the bound bucket, where a new playlist is written (ADR-0006). */
export function boundPlaylistTarget(env: Env): PlaylistTarget {
  return { libraryId: DEFAULT_LIBRARY_ID, storage: bindingStorage(env) };
}

/** Why a playlist's library cannot take a write. */
export type PlaylistTargetRefusal =
  /** The library is gone, or being removed: its playlists are, too. */
  | "not_found"
  /** The library's last connection test found it read-only (#84). */
  | "read_only";

/**
 * Where a write of an existing playlist in this library goes, or why it
 * cannot. Library 1 is the bound bucket, which the binding always writes, so
 * its row is not read and a library-1 write runs v0.5.0's statements; any
 * other library's row is read for its bucket, its token, its state and its
 * `writable`, with every library's path, in one round trip. Nothing is
 * written either way.
 */
export async function playlistTarget(
  env: Env,
  db: Database,
  libraryId: number,
): Promise<PlaylistTarget | PlaylistTargetRefusal> {
  if (libraryId === DEFAULT_LIBRARY_ID) {
    return boundPlaylistTarget(env);
  }

  const { row, paths } = await findPlaylistLibrary(db, libraryId);
  if (row === null || row.state !== "active") {
    return "not_found";
  }
  if (!row.writable) {
    return "read_only";
  }

  return { libraryId, storage: storageFor(env, row), paths };
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
  /** The tracks it holds, in order, duplicates and all, each with its library. */
  readonly tracks: readonly EntryTrack[];
}

/**
 * Puts the `.m3u` in the target's bucket and then writes the row it implies.
 * Answers with the id, which is the hash of the library and the key either
 * way, so the caller does not have to know whether the playlist existed.
 *
 * The paths of the other libraries its tracks are in are read first, unless
 * the target came with them, and only when there are any: a playlist of its
 * own library's tracks reads nothing more than it did.
 */
export async function writePlaylist(
  db: Database,
  target: PlaylistTarget,
  write: PlaylistWrite,
): Promise<string> {
  const name = playlistNameForFile(write.name);
  const others = [
    ...new Set(
      write.tracks
        .map((entry) => entry.libraryId)
        .filter((libraryId) => libraryId !== target.libraryId),
    ),
  ];
  const paths =
    others.length === 0
      ? new Map<number, string>()
      : (target.paths ?? (await findLibraryPaths(db, others)));
  const text = renderM3u(
    name,
    write.tracks.map((entry) => playlistLine(target.libraryId, entry, paths)),
  );

  const object = await target.storage.put(write.r2Key, new TextEncoder().encode(text));
  if (object === null) {
    // The bucket refused the write. Nothing goes to D1: a row whose file
    // does not exist is the one state this order exists to avoid.
    throw new Error(`playlists: library ${target.libraryId} refused ${write.r2Key}`);
  }

  const imported: ImportedPlaylist = {
    id: playlistId(target.libraryId, write.r2Key),
    name,
    comment: write.comment,
    ownerId: write.ownerId,
    public: write.public,
    songCount: write.tracks.length,
    duration: write.tracks.reduce((total, entry) => total + entry.duration, 0),
    r2Key: write.r2Key,
    libraryId: target.libraryId,
    // The object's own clock, as the import reads it, so the next pass over
    // this untouched file changes nothing a client can see.
    createdAt: write.createdAt ?? object.uploaded,
    changedAt: object.uploaded,
    trackIds: write.tracks.map((entry) => entry.id),
  };

  await runBatch(
    db,
    upsertPlaylistStatements(db, imported, { writesDetails: write.writesDetails }),
  );

  return imported.id;
}

/**
 * Removes a playlist's file from the target's bucket and then its row.
 *
 * That order again, for the same reason read the other way: a crash in
 * between leaves a row whose file has gone, which the next sweep removes. The
 * other order would leave an `.m3u` the next pass imports, and a listener
 * would watch a playlist they deleted come back.
 */
export async function erasePlaylist(
  db: Database,
  target: PlaylistTarget,
  id: string,
  r2Key: string,
): Promise<void> {
  await target.storage.delete([r2Key]);
  await deletePlaylistRow(db, id);
}

/**
 * Removes many playlists' files from one library's bucket, in one call per
 * thousand keys, and none for no key (storage/storage.ts, `delete`). Deleting
 * a key that is not there is not an error, and deleting is a free R2
 * operation. The keys are used exactly as given: they name what a listing
 * returned (files/keys.ts). A binding call counts against the Worker's 1,000
 * internal subrequests, and an S3 one against its 50 external ones.
 *
 * The rows are the caller's to delete afterwards, in the order
 * `erasePlaylist` keeps and for its reason: a crash in between leaves rows
 * whose files have gone, which the next sweep removes, never a file that the
 * next pass would bring back as a playlist. A call the bucket fails throws,
 * and the rows stay.
 */
export function erasePlaylistFiles(
  storage: LibraryStorage,
  r2Keys: readonly string[],
): Promise<void> {
  return storage.delete(r2Keys);
}
