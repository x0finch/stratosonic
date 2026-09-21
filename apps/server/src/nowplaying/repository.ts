/**
 * The `now_playing` table: who is listening to what, one row per user.
 *
 * `scrobble` with `submission=false` registers a row at the start of a track;
 * `getNowPlaying` reads the rows still inside the TTL window. Nothing sweeps a
 * stale row — the next track a user starts overwrites their one row in place,
 * and a read filters by the window — so the free tier runs no cleaner.
 */

import { album, annotation, nowPlaying, track, user } from "@stratosonic/db";
import { desc, eq, gte } from "drizzle-orm";
import type { Database } from "../db";
import { annotationColumns, annotationJoin } from "../library/annotations";
import { toSongView } from "../library/repository";
import type { SongView } from "../library/serializers";

/**
 * Registers the caller as now playing a track, replacing their one row. The
 * player name is the client's `c`, which the now-playing feed shows.
 */
export async function registerNowPlaying(
  db: Database,
  userId: string,
  trackId: string,
  playerName: string,
  startedAt: Date,
): Promise<void> {
  await db
    .insert(nowPlaying)
    .values({ userId, trackId, playerName, startedAt })
    .onConflictDoUpdate({
      target: nowPlaying.userId,
      set: { trackId, playerName, startedAt },
    });
}

/** One current listener: the song, who is playing it, when, and on what. */
export interface NowPlayingEntry {
  readonly song: SongView;
  readonly username: string;
  readonly startedAt: Date;
  readonly playerName: string;
}

/**
 * Everyone now playing a track that started at or after `since` — the near
 * edge of the TTL window — most recent first.
 *
 * The track is inner-joined, so an entry whose track has since left the
 * library drops out rather than breaking the feed; the user is inner-joined
 * for the name the feed shows. The song carries the *caller's* annotation, as
 * every other read of a song does, so it looks the same here as anywhere.
 */
export async function listNowPlaying(
  db: Database,
  callerId: string,
  since: Date,
): Promise<NowPlayingEntry[]> {
  const rows = await db
    .select({
      track,
      albumName: album.name,
      albumCoverKey: album.coverKey,
      username: user.userName,
      playerName: nowPlaying.playerName,
      startedAt: nowPlaying.startedAt,
      ...annotationColumns,
    })
    .from(nowPlaying)
    .innerJoin(track, eq(track.id, nowPlaying.trackId))
    .leftJoin(album, eq(album.id, track.albumId))
    .innerJoin(user, eq(user.id, nowPlaying.userId))
    .leftJoin(annotation, annotationJoin(callerId, "track", track.id))
    .where(gte(nowPlaying.startedAt, since))
    .orderBy(desc(nowPlaying.startedAt));

  return rows.map((row) => ({
    song: toSongView(row),
    username: row.username,
    startedAt: row.startedAt,
    playerName: row.playerName,
  }));
}
