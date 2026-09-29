/**
 * The reads serving lyrics needs from D1: which track, where its sidecar
 * would be, and the lyrics its tags carry.
 *
 * Only the columns the answer uses are selected - the key the sidecar sits
 * beside, the artist and title a lyric without its own tags is displayed
 * with, and the embedded lyric the scan stored (`track_lyrics`). That table
 * is joined on its key rather than read by a second statement, so each
 * lookup stays one statement: a track with no lyrics row just comes back
 * with nulls. Nothing else is joined - lyrics are not decorated with the
 * caller's annotation. The candidate query filters on `track.title`, which
 * is not indexed, by design: a personal library is small enough to scan, the
 * same posture search and `getTopSongs` take.
 */

import { track, trackLyrics } from "@stratosonic/db";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import type { Database } from "../db";

/** What a lyrics lookup needs to know about a track. */
export interface LyricsTrack {
  readonly r2Key: string;
  readonly artist: string;
  readonly title: string;
  /** The lyric its tags carry, as the scan stored it, or null when they carry none. */
  readonly embedded: { readonly text: string; readonly lang: string } | null;
}

/**
 * How many tracks `getLyrics` looks at for one artist and title: Navidrome's
 * `maxLegacyLyricsCandidates` (core/lyrics/lyrics.go). Duplicates of a song
 * are common - a single and the album it is on - and the newest may be the
 * one without a sidecar, so more than one is tried; ten keeps the R2 reads
 * of a miss at twenty, well inside a request's subrequests.
 */
export const MAX_LYRICS_CANDIDATES = 10;

const lyricsTrackColumns = {
  r2Key: track.r2Key,
  artist: track.artist,
  title: track.title,
  embeddedText: trackLyrics.text,
  embeddedLang: trackLyrics.lang,
};

interface LyricsTrackRow {
  readonly r2Key: string;
  readonly artist: string;
  readonly title: string;
  readonly embeddedText: string | null;
  readonly embeddedLang: string | null;
}

/** The track with this bare id, or null when there is none. */
export async function findLyricsTrack(db: Database, id: string): Promise<LyricsTrack | null> {
  const rows = await db
    .select(lyricsTrackColumns)
    .from(track)
    .leftJoin(trackLyrics, eq(trackLyrics.trackId, track.id))
    .where(eq(track.id, id))
    .limit(1);

  const row = rows[0];

  return row === undefined ? null : lyricsTrack(row);
}

/**
 * The tracks `getLyrics` may answer with, in one statement: those with
 * embedded lyrics first, and newest first within each.
 *
 * The match is Navidrome's `songsByArtistTitleWithLyricsFirst`: the title
 * exactly, and the artist exactly as either the track's own artist or its
 * album artist - `=`, not `LIKE`, so case and `%` count. A track's album
 * artist is stored on the track, as the album it is grouped under is keyed
 * by it, so no join is needed to read it. Navidrome sorts by its `lyrics`
 * column and then `updated_at`, both descending, which puts the tracks whose
 * tags carry lyrics ahead of the rest; here that is whether a `track_lyrics`
 * row joined. The id breaks a tie so the order is stable.
 */
export async function findLyricsCandidates(
  db: Database,
  artist: string,
  title: string,
): Promise<LyricsTrack[]> {
  const rows = await db
    .select(lyricsTrackColumns)
    .from(track)
    .leftJoin(trackLyrics, eq(trackLyrics.trackId, track.id))
    .where(and(eq(track.title, title), or(eq(track.artist, artist), eq(track.albumArtist, artist))))
    .orderBy(desc(sql`${trackLyrics.trackId} is not null`), desc(track.updatedAt), asc(track.id))
    .limit(MAX_LYRICS_CANDIDATES);

  return rows.map(lyricsTrack);
}

function lyricsTrack(row: LyricsTrackRow): LyricsTrack {
  return {
    r2Key: row.r2Key,
    artist: row.artist,
    title: row.title,
    embedded:
      row.embeddedText === null
        ? null
        : { text: row.embeddedText, lang: row.embeddedLang ?? "xxx" },
  };
}
