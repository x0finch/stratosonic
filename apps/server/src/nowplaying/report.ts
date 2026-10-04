/**
 * A playback report, applied to the caller's session: Navidrome's
 * `playTracker.ReportPlayback` (`core/scrobbler/play_tracker.go`), which both
 * `reportPlayback` and `scrobble` with `submission=false` reach.
 *
 * The D1 cost is the point of the shape. Every report is one read — the
 * track and the caller's session together — and at most one write: an upsert
 * for `starting`, `playing` and `paused`, or one batch for `stopped` that
 * ends the session and counts the play. A report the stored session already
 * accounts for writes nothing (`isRedundant`).
 *
 * A client that reports a play both ways — a `stopped` here and a legacy
 * `scrobble` with `submission=true` — has it counted twice, as Navidrome
 * counts it: the extension's `ignoreScrobble` is how a client says a stop is
 * not a play, so the server does not try to tell the two apart.
 */

import { playStatements } from "../annotations/repository";
import type { Database } from "../db";
import type { LibraryScope } from "../library/scope";
import {
  endSessionStatement,
  findPlaybackContext,
  type PlaybackContext,
  storeSession,
} from "./repository";
import {
  expiryOf,
  isCurrent,
  isRedundant,
  type PlaybackState,
  playThresholdMs,
  type SessionState,
} from "./session";

/** What a client reported about the track it is playing. */
export interface PlaybackReport {
  readonly userId: string;
  readonly trackId: string;
  readonly state: PlaybackState;
  readonly positionMs: number;
  readonly playbackRate: number;
  /** Update the session only: a `stopped` counts no play. */
  readonly ignoreScrobble: boolean;
  /** The client's `c`, which the now-playing feed shows. */
  readonly playerName: string;
  /** The libraries the caller sees: a track out of them is not found. */
  readonly scope: LibraryScope;
}

/**
 * Applies a report to the caller's session. Answers `false`, having written
 * nothing, when the track is not in the caller's libraries.
 */
export async function reportPlayback(
  db: Database,
  report: PlaybackReport,
  now: Date = new Date(),
): Promise<boolean> {
  const context = await findPlaybackContext(db, report.userId, report.trackId, report.scope);
  if (context === null) {
    return false;
  }

  if (report.state === "stopped") {
    await stop(db, report, context, now);
  } else {
    await store(db, report, report.state, context, now);
  }

  return true;
}

/**
 * `starting`, `playing` and `paused`: the session is stored with the TTL of
 * its state, unless the report changes nothing.
 *
 * A `starting` for the track a current session is already playing is
 * ignored: clients send `starting` and `playing` in either order, and letting
 * the late one through would freeze the position estimate until the next
 * report (Navidrome's `hasPlayingSession` check). Otherwise `starting` begins
 * the session afresh, even on the same track, as the extension defines it.
 * `playing` and `paused` keep the start of a current session on the same
 * track, and begin one that far into the track when there is none.
 */
async function store(
  db: Database,
  report: PlaybackReport,
  state: SessionState,
  { track, session }: PlaybackContext,
  now: Date,
): Promise<void> {
  const at = now.getTime();
  const current = session !== null && isCurrent(session, at) ? session : null;
  const sameTrack = current !== null && current.trackId === report.trackId;

  if (state === "starting" && sameTrack && current.state === "playing") {
    return;
  }

  const reported = { ...report, state };
  if (current !== null && isRedundant(current, reported, track.duration, at)) {
    return;
  }

  // Never before the epoch: a position no track reaches would otherwise put
  // the start before the first instant a `Date` can hold.
  let startedAt = new Date(Math.max(at - report.positionMs, 0));
  if (state === "starting") {
    startedAt = now;
  } else if (sameTrack) {
    startedAt = current.startedAt;
  }

  await storeSession(
    db,
    report.userId,
    {
      trackId: report.trackId,
      playerName: report.playerName,
      state,
      positionMs: report.positionMs,
      playbackRate: report.playbackRate,
      startedAt,
      reportedAt: now,
      expiresAt: new Date(
        expiryOf(state, track.duration, report.positionMs, report.playbackRate, at),
      ),
    },
    { keepPlaying: state === "starting" },
  );
}

/**
 * `stopped`: the session on this track ends, and the play counts if the stop
 * came far enough into the track — both in one batch.
 *
 * The play is decided first and on its own, as Navidrome decides it: a stop
 * past the threshold counts, unless `ignoreScrobble`, whatever session the
 * caller has. The session is another matter. A stop for a track other than
 * the one the current session is on is a late report for the previous track,
 * and must not end the new one, so only a row on this track is deleted.
 */
async function stop(
  db: Database,
  report: PlaybackReport,
  { track, session }: PlaybackContext,
  now: Date,
): Promise<void> {
  const statements = [];

  if (session !== null && session.trackId === report.trackId) {
    statements.push(endSessionStatement(db, report.userId, report.trackId));
  }

  if (!report.ignoreScrobble && report.positionMs >= playThresholdMs(track.duration)) {
    // A play counts for the track, its album and its artist, as Navidrome's
    // `incPlay` counts it, and moves each one's `played` forward only.
    statements.push(
      ...playStatements(db, report.userId, [
        { item: { type: "track", id: report.trackId }, playDate: now },
        { item: { type: "album", id: track.albumId }, playDate: now },
        { item: { type: "artist", id: track.artistId }, playDate: now },
      ]),
    );
  }

  const [first, ...rest] = statements;
  if (first === undefined) {
    return;
  }

  await db.batch([first, ...rest]);
}
