/**
 * The reads serving lyrics needs from D1: which track, and where its sidecar
 * would be.
 *
 * Only the columns the answer uses are selected - the key the sidecar sits
 * beside, and the artist and title a lyric without its own tags is displayed
 * with. Nothing is joined: lyrics are not decorated with the caller's
 * annotation, so each lookup is one statement over the track table. The
 * candidate query filters on `track.title`, which is not indexed, by design:
 * a personal library is small enough to scan, the same posture search and
 * `getTopSongs` take.
 */

import { track } from "@stratosonic/db";
import { and, asc, desc, eq, or } from "drizzle-orm";
import type { Database } from "../db";

/** What a lyrics lookup needs to know about a track. */
export interface LyricsTrack {
  readonly r2Key: string;
  readonly artist: string;
  readonly title: string;
}

/**
 * How many tracks `getLyrics` looks at for one artist and title: Navidrome's
 * `maxLegacyLyricsCandidates` (core/lyrics/lyrics.go). Duplicates of a song
 * are common - a single and the album it is on - and the newest may be the
 * one without a sidecar, so more than one is tried; ten keeps the R2 reads
 * of a miss at twenty, well inside a request's subrequests.
 */
export const MAX_LYRICS_CANDIDATES = 10;

const lyricsTrackColumns = { r2Key: track.r2Key, artist: track.artist, title: track.title };

/** The track with this bare id, or null when there is none. */
export async function findLyricsTrack(db: Database, id: string): Promise<LyricsTrack | null> {
  const rows = await db.select(lyricsTrackColumns).from(track).where(eq(track.id, id)).limit(1);

  return rows[0] ?? null;
}

/**
 * The tracks `getLyrics` may answer with, newest first, in one statement.
 *
 * The match is Navidrome's `songsByArtistTitleWithLyricsFirst`: the title
 * exactly, and the artist exactly as either the track's own artist or its
 * album artist - `=`, not `LIKE`, so case and `%` count. A track's album
 * artist is stored on the track, as the album it is grouped under is keyed
 * by it, so no join is needed to read it. Navidrome sorts the tracks with
 * embedded lyrics first, which this server does not read, and then by
 * `updated_at` descending; the id breaks a tie so the order is stable.
 */
export async function findLyricsCandidates(
  db: Database,
  artist: string,
  title: string,
): Promise<LyricsTrack[]> {
  return db
    .select(lyricsTrackColumns)
    .from(track)
    .where(and(eq(track.title, title), or(eq(track.artist, artist), eq(track.albumArtist, artist))))
    .orderBy(desc(track.updatedAt), asc(track.id))
    .limit(MAX_LYRICS_CANDIDATES);
}
