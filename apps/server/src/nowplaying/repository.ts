/**
 * The `now_playing` table: who is listening to what, one row per user.
 *
 * `reportPlayback` and `scrobble` with `submission=false` store the caller's
 * playback session here (`report.ts`), and `getNowPlaying` reads the rows
 * whose expiry has not passed. Nothing sweeps a stale row — the caller's next
 * report overwrites their one row in place, and a read filters by expiry — so
 * the free tier runs no cleaner.
 */

import { album, annotation, nowPlaying, subsonicUser, track } from "@stratosonic/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "../db";
import { annotationColumns, annotationJoin } from "../library/annotations";
import { toSongView } from "../library/repository";
import type { SongView } from "../library/serializers";
import type { SessionState, StoredSession } from "./session";

/** The track a report names, as far as a playback session needs it. */
export interface ReportedTrack {
  /** Seconds, which the session's expiry and play threshold are measured in. */
  readonly duration: number;
  readonly albumId: string;
  readonly artistId: string;
}

/** A report's track, and the caller's session as it stands, if any. */
export interface PlaybackContext {
  readonly track: ReportedTrack;
  readonly session: StoredSession | null;
}

/**
 * The track a report names and the caller's stored session, in one statement,
 * or `null` when the track is not in the library.
 *
 * The session is left-joined whatever track it is on: a report for another
 * track has to know what the caller is playing now as much as one for the
 * same track does, and an expired row still comes back — whether it counts
 * is `isCurrent`'s question, not the query's.
 */
export async function findPlaybackContext(
  db: Database,
  userId: string,
  trackId: string,
): Promise<PlaybackContext | null> {
  const [row] = await db
    .select({
      duration: track.duration,
      albumId: track.albumId,
      artistId: track.artistId,
      session: {
        trackId: nowPlaying.trackId,
        playerName: nowPlaying.playerName,
        state: nowPlaying.state,
        positionMs: nowPlaying.positionMs,
        playbackRate: nowPlaying.playbackRate,
        startedAt: nowPlaying.startedAt,
        reportedAt: nowPlaying.reportedAt,
        expiresAt: nowPlaying.expiresAt,
      },
    })
    .from(track)
    .leftJoin(nowPlaying, eq(nowPlaying.userId, userId))
    .where(eq(track.id, trackId))
    .limit(1);

  if (row === undefined) {
    return null;
  }

  return {
    track: { duration: row.duration, albumId: row.albumId, artistId: row.artistId },
    session: row.session,
  };
}

/** What a report stores as the caller's session. */
export interface SessionWrite {
  readonly trackId: string;
  readonly playerName: string;
  readonly state: SessionState;
  readonly positionMs: number;
  readonly playbackRate: number;
  readonly startedAt: Date;
  readonly reportedAt: Date;
  readonly expiresAt: Date;
}

/**
 * Stores the caller's session, replacing their one row, in one statement.
 *
 * `keepPlaying` is the `starting` guard, and it is in the statement rather
 * than only in the read before it: a late `starting` must not replace a
 * current session already playing the same track, and a `playing` that lands
 * between the read and this write is exactly that session. Navidrome re-checks
 * under a mutex for the same reason.
 */
export async function storeSession(
  db: Database,
  userId: string,
  session: SessionWrite,
  options: { readonly keepPlaying: boolean },
): Promise<void> {
  const now = session.reportedAt.getTime();

  await db
    .insert(nowPlaying)
    .values({ userId, ...session })
    .onConflictDoUpdate({
      target: nowPlaying.userId,
      set: session,
      setWhere: options.keepPlaying
        ? sql`not (${nowPlaying.trackId} = ${session.trackId} and ${nowPlaying.state} = 'playing' and ${nowPlaying.expiresAt} >= ${now})`
        : undefined,
    });
}

/**
 * The statement that ends the caller's session on this track — and only on
 * this track, so a stop that raced a report for the next one leaves the new
 * session alone.
 */
export function endSessionStatement(
  db: Database,
  userId: string,
  trackId: string,
): BatchItem<"sqlite"> {
  return db
    .delete(nowPlaying)
    .where(and(eq(nowPlaying.userId, userId), eq(nowPlaying.trackId, trackId)));
}

/** One current listener: the song, who is playing it, and how far along. */
export interface NowPlayingEntry {
  readonly song: SongView;
  readonly username: string;
  readonly session: StoredSession;
}

/**
 * Everyone whose session is current at `now`, the most recently started
 * first, as Navidrome sorts its sessions by their start.
 *
 * The track is inner-joined, so an entry whose track has since left the
 * library drops out rather than breaking the feed; the user is inner-joined
 * for the name the feed shows. The song carries the *caller's* annotation, as
 * every other read of a song does, so it looks the same here as anywhere.
 */
export async function listNowPlaying(
  db: Database,
  callerId: string,
  now: Date,
): Promise<NowPlayingEntry[]> {
  return toNowPlayingEntries(await nowPlayingQuery(db, callerId, now));
}

/**
 * `listNowPlaying`'s statement, unrun, for a caller that sends it in a
 * `db.batch` with others (the console's overview, api/overview.ts);
 * `toNowPlayingEntries` reads what it returns.
 *
 * Its columns are safe to batch: Drizzle reads a batched result by column
 * position from D1's row objects, which keep one value per column *name*, and
 * no two of the joined columns share one (the track's own, the album's `name`
 * and `cover_key`, `user_name`, the session's and the annotation's).
 */
export function nowPlayingQuery(db: Database, callerId: string, now: Date) {
  return db
    .select({
      track,
      albumName: album.name,
      albumCoverKey: album.coverKey,
      username: subsonicUser.userName,
      session: {
        trackId: nowPlaying.trackId,
        playerName: nowPlaying.playerName,
        state: nowPlaying.state,
        positionMs: nowPlaying.positionMs,
        playbackRate: nowPlaying.playbackRate,
        startedAt: nowPlaying.startedAt,
        reportedAt: nowPlaying.reportedAt,
        expiresAt: nowPlaying.expiresAt,
      },
      ...annotationColumns,
    })
    .from(nowPlaying)
    .innerJoin(track, eq(track.id, nowPlaying.trackId))
    .leftJoin(album, eq(album.id, track.albumId))
    .innerJoin(subsonicUser, eq(subsonicUser.id, nowPlaying.userId))
    .leftJoin(annotation, annotationJoin(callerId, "track", track.id))
    .where(gte(nowPlaying.expiresAt, now))
    .orderBy(desc(nowPlaying.startedAt));
}

/** The rows `nowPlayingQuery` returns, as `listNowPlaying` answers them. */
export function toNowPlayingEntries(
  rows: Awaited<ReturnType<typeof nowPlayingQuery>>,
): NowPlayingEntry[] {
  return rows.map((row) => ({
    song: toSongView(row),
    username: row.username,
    session: row.session,
  }));
}
