/**
 * The `bookmark` table: where each listener stopped in a track.
 *
 * A row belongs to a `(user, track)`, so two accounts sharing a library keep
 * their own places in the same long mix, and every read and write here is the
 * caller's alone. `createBookmark` upserts, which is what makes a client that
 * re-sends a bookmark it already has move the place rather than fail — and why
 * `createdAt` is kept while `changedAt` moves, since that pair is what
 * `getBookmarks` answers with.
 */

import { album, annotation, bookmark, track } from "@stratosonic/db";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Database } from "../db";
import { annotationColumns, annotationJoin } from "../library/annotations";
import { toSongView } from "../library/repository";
import type { SongView } from "../library/serializers";

/**
 * Records where the caller stopped in a track, or moves a place they had
 * already marked.
 *
 * One statement either way: a bookmark the caller already has keeps the
 * instant it was first made and takes the new position, comment and
 * `changedAt`, so re-bookmarking is an update rather than a second row or a
 * refusal.
 */
export async function saveBookmark(
  db: Database,
  userId: string,
  trackId: string,
  position: number,
  comment: string,
  now: Date,
): Promise<void> {
  await db
    .insert(bookmark)
    .values({ userId, trackId, position, comment, createdAt: now, changedAt: now })
    .onConflictDoUpdate({
      target: [bookmark.userId, bookmark.trackId],
      set: { position, comment, changedAt: now },
    });
}

/**
 * Forgets the caller's bookmark for a track, and says whether there was one.
 *
 * The deleted rows are returned by the same statement rather than counted by a
 * second one, because "there was nothing to delete" is the answer the endpoint
 * turns into error 70.
 */
export async function deleteBookmark(
  db: Database,
  userId: string,
  trackId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(bookmark)
    .where(and(eq(bookmark.userId, userId), eq(bookmark.trackId, trackId)))
    .returning({ trackId: bookmark.trackId });

  return deleted.length > 0;
}

/** One bookmark: the song it marks, and what the caller left on it. */
export interface BookmarkEntry {
  readonly song: SongView;
  /** Milliseconds into the track. */
  readonly position: number;
  readonly comment: string;
  readonly createdAt: Date;
  readonly changedAt: Date;
}

/**
 * The caller's bookmarks, most recently moved first.
 *
 * Navidrome's `GetBookmarks` asks for no order at all, so one is chosen here
 * rather than left to the database: a client offering to resume wants the
 * place the listener left last, and the track id breaks a tie so the list does
 * not shuffle between requests.
 *
 * The track is inner-joined, so a bookmark whose track has left the library
 * drops out of the list rather than rendering an `<entry>` with nothing in it.
 * The song carries the caller's annotation, as every other read of a song
 * does.
 */
export async function listBookmarks(db: Database, userId: string): Promise<BookmarkEntry[]> {
  const rows = await db
    .select({
      track,
      albumName: album.name,
      albumCoverKey: album.coverKey,
      position: bookmark.position,
      comment: bookmark.comment,
      createdAt: bookmark.createdAt,
      changedAt: bookmark.changedAt,
      ...annotationColumns,
    })
    .from(bookmark)
    .innerJoin(track, eq(track.id, bookmark.trackId))
    .leftJoin(album, eq(album.id, track.albumId))
    .leftJoin(annotation, annotationJoin(userId, "track", track.id))
    .where(eq(bookmark.userId, userId))
    .orderBy(desc(bookmark.changedAt), asc(bookmark.trackId));

  return rows.map((row) => ({
    song: toSongView(row),
    position: row.position,
    comment: row.comment,
    createdAt: row.createdAt,
    changedAt: row.changedAt,
  }));
}
