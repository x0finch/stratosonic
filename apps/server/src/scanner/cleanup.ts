/**
 * The cleanup of a removed library: the second half of a removal (#84,
 * "Removing a library"; ADR-0009).
 *
 * `DELETE /api/libraries/:id` marks the library `removing`, which hides it
 * from every reader at once, and deletes its grants and its playlists. What
 * is left - its tracks, albums, their annotations and bookmarks, the covers
 * the scan extracted for it - is deleted here, by the scan driver, as the
 * first phase of a pass, because Stratosonic has no cascade from `library`
 * (tracks and albums carry no foreign key) and D1's daily write cap rules out
 * one unbounded transaction. Navidrome's removal is its cascade, then its GC
 * (`core/library.go: deleteOne`, `persistence.go: GC`).
 *
 * One stage a step, each one batch, each bounded:
 *
 * 1. up to `CLEANUP_TRACKS_PER_STEP` tracks, with their annotations and
 *    bookmarks (their lyrics go by cascade);
 * 2. once no track is left, up to as many albums, with their annotations and
 *    their cover objects in the bound bucket;
 * 3. then, in one batch, the playlist entries left pointing at nothing, the
 *    annotations of the playlists the request deleted, the artists left with
 *    no album anywhere with their annotations (a shared artist keeps its
 *    stars), the library's memo of broken objects, and finally the library
 *    row.
 *
 * The library's own bucket is never touched: not listed, not read, not
 * written. Its writes count against the daily write budget.
 *
 * A step costs at most five subrequests: the scan's state read, the track
 * lookup, the album lookup, one bulk cover delete and the batch.
 */

import type { Database } from "../db";
import type { LibraryStorage } from "../storage/storage";
import { ROWS_PER_REMOVED_TRACK, tallyStatement } from "./budget";
import {
  deleteAlbumsWithAnnotationsStatements,
  deleteOrphanPlaylistAnnotationsStatement,
  deleteRemovedLibraryStatement,
  deleteTracksWithAnnotationsStatements,
  findLibraryAlbums,
  findLibraryTrackIds,
  pruneEmptyArtistsWithAnnotationsStatements,
  pruneOrphanPlaylistEntriesStatement,
  runBatch,
} from "./repository";
import { deleteBrokenObjectsStatement } from "./state";

/** How many tracks, or albums, one cleanup step deletes. */
export const CLEANUP_TRACKS_PER_STEP = 500;

/** Rows an album costs: the row, its index and an annotation or two. */
const ROWS_PER_REMOVED_ALBUM = 3;

/** Which stage a cleanup step ran. */
export type CleanupStage = "tracks" | "albums" | "library";

/**
 * Runs one bounded step of the cleanup of library `libraryId`, which the
 * caller read as `removing`, and says which stage it ran. `covers` is the
 * bound bucket, where every library's covers are. `day` is the UTC day the
 * rows are counted against (`scanner/budget.ts`).
 */
export async function cleanUpLibrary(
  db: Database,
  covers: LibraryStorage,
  libraryId: number,
  day: string,
): Promise<CleanupStage> {
  const tracks = await findLibraryTrackIds(db, libraryId, CLEANUP_TRACKS_PER_STEP);
  if (tracks.length > 0) {
    await runBatch(db, [
      ...deleteTracksWithAnnotationsStatements(db, tracks),
      tallyStatement(db, day, ROWS_PER_REMOVED_TRACK * tracks.length + 1),
    ]);
    console.log(`scan: removed library ${libraryId}: deleted ${tracks.length} tracks`);

    return "tracks";
  }

  const albums = await findLibraryAlbums(db, libraryId, CLEANUP_TRACKS_PER_STEP);
  if (albums.length > 0) {
    // The covers first: a batch that then fails leaves albums pointing at no
    // object, which the next step deletes, rather than objects nothing
    // points at, which nothing would.
    await covers.delete(
      albums.map((row) => row.coverKey).filter((key): key is string => key !== null),
    );
    await runBatch(db, [
      ...deleteAlbumsWithAnnotationsStatements(
        db,
        albums.map((row) => row.id),
      ),
      tallyStatement(db, day, ROWS_PER_REMOVED_ALBUM * albums.length + 1),
    ]);
    console.log(`scan: removed library ${libraryId}: deleted ${albums.length} albums`);

    return "albums";
  }

  const last = [
    pruneOrphanPlaylistEntriesStatement(db),
    deleteOrphanPlaylistAnnotationsStatement(db),
    ...pruneEmptyArtistsWithAnnotationsStatements(db),
    deleteBrokenObjectsStatement(db, libraryId),
    deleteRemovedLibraryStatement(db, libraryId),
  ];
  await runBatch(db, [...last, tallyStatement(db, day, last.length + 1)]);
  console.log(`scan: removed library ${libraryId}: the library is gone`);

  return "library";
}
