/**
 * The Playback-state module: what a client saves to resume a session — the
 * now-playing feed here, and (next) the play queue and bookmarks.
 */

import { database } from "../db";
import { omitWhenEmpty, songElement } from "../library/serializers";
import { listNowPlaying, type NowPlayingEntry } from "../nowplaying/repository";
import type { SubsonicNode } from "../subsonic/response";
import type { SubsonicHandler } from "../subsonic/router";

/**
 * The outer bound on a now-playing entry, and the near edge of the window the
 * read asks SQL for. Navidrome never keeps an entry longer than an hour, so a
 * row older than this is stale whatever its track's length, and filtering it
 * out in the query keeps the rows the feed reads bounded.
 */
const NOW_PLAYING_MAX_TTL_MS = 60 * 60_000;

/**
 * What Navidrome adds to the track's own length: its `playTracker.NowPlaying`
 * stores the entry with a TTL of `duration + 5s`, so an entry leaves the feed
 * about when the track it names would have finished.
 */
const NOW_PLAYING_GRACE_MS = 5_000;

/**
 * The floor under that TTL, for a track whose `duration` is 0 — never read
 * from the file, or genuinely unknown. Five seconds would drop such an entry
 * almost as soon as it was registered, so it lives a minute instead.
 */
const NOW_PLAYING_MIN_TTL_MS = 60_000;

/**
 * `getNowPlaying` — who is currently listening, across every account.
 *
 * Only entries still inside their own TTL come back, so a track a listener
 * stopped drops out on its own: the query prefilters on the hour that bounds
 * every entry, and each remaining row is then measured against the length of
 * the track it names. Each entry is the `<song>` plus the listener's
 * `username`, how long ago they started (`minutesAgo`), the `playerId`
 * Navidrome always renders as 0, and the `playerName` the client sent.
 */
export const getNowPlaying: SubsonicHandler = async (request) => {
  const now = Date.now();
  const since = new Date(now - NOW_PLAYING_MAX_TTL_MS);

  const entries = await listNowPlaying(database(request.env), request.user.id, since);
  const current = entries.filter((entry) => now <= expiryOf(entry));

  return {
    nowPlaying: {
      entry: omitWhenEmpty(current.map((entry) => nowPlayingEntryElement(entry, now))),
    },
  };
};

/** The instant an entry stops being current: its start plus its own TTL. */
function expiryOf(entry: NowPlayingEntry): number {
  const trackTtl = entry.song.duration * 1_000 + NOW_PLAYING_GRACE_MS;

  return entry.startedAt.getTime() + Math.max(trackTtl, NOW_PLAYING_MIN_TTL_MS);
}

/**
 * `<entry>`, Navidrome's `NowPlayingEntry`: the `Child` (the song) with
 * `username`, `minutesAgo`, `playerId` and `playerName` after it, in that
 * order. `playerId` is required by the XSD and Navidrome renders it as 0 —
 * it has no player registry to name — so this does the same.
 */
function nowPlayingEntryElement(entry: NowPlayingEntry, now: number): SubsonicNode {
  return {
    ...songElement(entry.song),
    username: entry.username,
    minutesAgo: Math.floor((now - entry.startedAt.getTime()) / 60_000),
    playerId: 0,
    playerName: entry.playerName || undefined,
  };
}
