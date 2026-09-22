/**
 * The one read serving lyrics needs from D1: which track, and where its
 * sidecar would be.
 *
 * Only the columns the answer uses are selected - the key the sidecar sits
 * beside, and the artist and title a lyric without its own tags is displayed
 * with. Nothing is joined: lyrics are not decorated with the caller's
 * annotation, so the lookup is one statement over the track's primary key.
 */

import { track } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import type { Database } from "../db";

/** What a lyrics lookup needs to know about a track. */
export interface LyricsTrack {
  readonly r2Key: string;
  readonly artist: string;
  readonly title: string;
}

const lyricsTrackColumns = { r2Key: track.r2Key, artist: track.artist, title: track.title };

/** The track with this bare id, or null when there is none. */
export async function findLyricsTrack(db: Database, id: string): Promise<LyricsTrack | null> {
  const rows = await db.select(lyricsTrackColumns).from(track).where(eq(track.id, id)).limit(1);

  return rows[0] ?? null;
}
