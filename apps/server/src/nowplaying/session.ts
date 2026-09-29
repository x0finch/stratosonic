/**
 * The rules of a playback session, as Navidrome's play tracker applies them
 * (`core/scrobbler/play_tracker.go`): how long a session stays current, where
 * its position is by now, when a stop counts as a play — and, because D1
 * bills per row written where Navidrome's cache costs nothing, which reports
 * carry nothing worth storing.
 *
 * Everything here is arithmetic over a stored session and a clock; the
 * statements live in `repository.ts` and the order they run in in
 * `report.ts`.
 */

/** The states a client reports, as the `playbackReport` extension names them. */
export const PLAYBACK_STATES = ["starting", "playing", "paused", "stopped"] as const;

export type PlaybackState = (typeof PLAYBACK_STATES)[number];

/** The states a stored session can be in: a stopped session has no row. */
export type SessionState = Exclude<PlaybackState, "stopped">;

/** Whether a client's `state` is one the extension defines. */
export function isPlaybackState(value: string): value is PlaybackState {
  return (PLAYBACK_STATES as readonly string[]).includes(value);
}

/** A caller's stored session, as the `now_playing` row holds it. */
export interface StoredSession {
  readonly trackId: string;
  readonly playerName: string;
  readonly state: string;
  readonly positionMs: number;
  readonly playbackRate: number;
  readonly startedAt: Date;
  readonly reportedAt: Date;
  readonly expiresAt: Date;
}

/** Navidrome keeps a paused session for half an hour (`ReportPlayback`). */
const PAUSED_TTL_MS = 30 * 60_000;

/**
 * What Navidrome's `remainingTTL` adds to the time a track has left: the
 * session outlives the track's planned end by five seconds.
 */
const GRACE_MS = 5_000;

/**
 * The floor under a starting or playing session's TTL. Navidrome has none,
 * but this server always kept a minute for the legacy now-playing, whose
 * track may have a `duration` of 0 — never read, or genuinely unknown — and
 * would otherwise leave the feed five seconds after it arrived.
 */
const MIN_TTL_MS = 60_000;

/**
 * The ceiling over it. Navidrome has none either, and needs none: a Go
 * duration saturates. Here a rate of `1e-300` would put the expiry past the
 * last instant a `Date` can hold, and the report would fail rather than be
 * stored; no track plays for a day.
 */
const MAX_TTL_MS = 24 * 60 * 60_000;

/**
 * How long a `starting` or `playing` session lives: the time the track has
 * left at this rate, in whole seconds, plus the grace — Navidrome's
 * `remainingTTL`, truncations and all — and between `MIN_TTL_MS` and
 * `MAX_TTL_MS`.
 */
export function playingTtlMs(durationSec: number, positionMs: number, rate: number): number {
  const remainingMs = (durationMs(durationSec) - positionMs) / rate;
  const remainingSec = Math.max(Math.trunc(remainingMs / 1_000), 0);

  return Math.min(Math.max(remainingSec * 1_000 + GRACE_MS, MIN_TTL_MS), MAX_TTL_MS);
}

/** The instant a session reported now in this state stops being current. */
export function expiryOf(
  state: SessionState,
  durationSec: number,
  positionMs: number,
  rate: number,
  now: number,
): number {
  const ttl = state === "paused" ? PAUSED_TTL_MS : playingTtlMs(durationSec, positionMs, rate);

  return now + ttl;
}

/**
 * Whether a stored session is still current, as Navidrome's cache still
 * holds an entry until its expiry has passed.
 */
export function isCurrent(session: StoredSession, now: number): boolean {
  return session.expiresAt.getTime() >= now;
}

/**
 * Where a session is by now: the reported position moved on by the time since
 * the report at its rate, and never past the end of the track — Navidrome's
 * `GetNowPlaying`. Only a playing session moves; a starting one is still
 * buffering and a paused one is where it stopped.
 */
export function estimatedPositionMs(
  session: StoredSession,
  durationSec: number,
  now: number,
): number {
  if (session.state !== "playing") {
    return session.positionMs;
  }

  return Math.min(extrapolatedPositionMs(session, now), durationMs(durationSec));
}

/** A playing session's position moved on by the time since its report. */
function extrapolatedPositionMs(session: StoredSession, now: number): number {
  const elapsed = now - session.reportedAt.getTime();

  return session.positionMs + Math.trunc(elapsed * session.playbackRate);
}

/**
 * How far into a track a stop has to be for it to count as a play: half the
 * track, or four minutes, whichever comes first — Navidrome's `stopped`
 * branch, which is the Last.fm rule. A track of unknown length counts from 0.
 */
export function playThresholdMs(durationSec: number): number {
  return Math.min(Math.trunc((durationMs(durationSec) * 50) / 100), 240_000);
}

/**
 * How far a report's position may sit from where the stored session says the
 * client should be and still carry no news. Clients report every few
 * seconds; the estimate already knows where they are.
 */
const POSITION_TOLERANCE_MS = 2_000;

/**
 * How long a paused session is left unwritten when every report repeats it.
 * A paused session's expiry is half an hour from its last write, so a client
 * that keeps saying "still paused" has to move it on now and then — every
 * five minutes is six writes an expiry, not one a report.
 */
const PAUSED_REFRESH_MS = 5 * 60_000;

/**
 * How much later than the stored expiry a playing report may put it and
 * still be skipped. A track with a known length expires where the estimate
 * ends it, within the position tolerance; only a floored TTL drifts.
 */
const EXPIRY_SLACK_MS = 30_000;

/** A report, as far as the session's throttle needs to know it. */
export interface ReportedPosition {
  readonly trackId: string;
  readonly playerName: string;
  readonly state: SessionState;
  readonly positionMs: number;
  readonly playbackRate: number;
}

/**
 * Whether storing this report would change nothing a reader can tell apart:
 * the current session is already on this track, from this player, in this
 * state and at this rate, and where it says it is lies within
 * `POSITION_TOLERANCE_MS` of where the session already puts it. A paused
 * session is still written once `PAUSED_REFRESH_MS` has passed since its last
 * write, so that it does not expire while the client is still paused.
 * Likewise a starting or playing session is written once storing the report
 * would move its expiry on by more than `EXPIRY_SLACK_MS`: that is a session
 * living on its `MIN_TTL_MS` floor — a track whose length was never read —
 * which would otherwise expire a minute in while the client plays on.
 *
 * Navidrome stores every report, in memory; a write per report is a row per
 * user every few seconds of listening against D1's daily hundred thousand.
 * Skipping one moves nothing: a playing session's expiry is the track's end,
 * and the track ends when the estimate says it does.
 */
export function isRedundant(
  session: StoredSession,
  report: ReportedPosition,
  durationSec: number,
  now: number,
): boolean {
  if (
    !isCurrent(session, now) ||
    session.trackId !== report.trackId ||
    session.playerName !== report.playerName ||
    session.state !== report.state ||
    session.playbackRate !== report.playbackRate
  ) {
    return false;
  }

  if (report.state === "paused") {
    if (now - session.reportedAt.getTime() >= PAUSED_REFRESH_MS) {
      return false;
    }
  } else {
    const expiry = expiryOf(report.state, durationSec, report.positionMs, report.playbackRate, now);
    if (expiry - session.expiresAt.getTime() > EXPIRY_SLACK_MS) {
      return false;
    }
  }

  // Measured against the position uncapped by the track's length, so that a
  // track whose length was never read (a `duration` of 0) is not rewritten
  // on every report for being "past its end".
  const expected =
    session.state === "playing" ? extrapolatedPositionMs(session, now) : session.positionMs;

  return Math.abs(report.positionMs - expected) <= POSITION_TOLERANCE_MS;
}

/** A duration in seconds as whole milliseconds, as Navidrome's `int64(d*1000)`. */
function durationMs(durationSec: number): number {
  return Math.trunc(durationSec * 1_000);
}
