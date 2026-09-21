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
 * How long a now-playing entry stays current. Navidrome keeps an entry for the
 * length of the track and no longer than an hour; with no per-track duration
 * stored here, the window is that fixed hour, after which a stale entry is
 * simply not returned (and is overwritten in place by the user's next track).
 */
const NOW_PLAYING_TTL_MS = 60 * 60_000;

/**
 * `getNowPlaying` — who is currently listening, across every account.
 *
 * Only entries started within the TTL window come back, so a track a listener
 * stopped drops out on its own. Each entry is the `<song>` plus the listener's
 * `username`, how long ago they started (`minutesAgo`) and the `playerName`
 * the client sent.
 */
export const getNowPlaying: SubsonicHandler = async (request) => {
  const now = Date.now();
  const since = new Date(now - NOW_PLAYING_TTL_MS);

  const entries = await listNowPlaying(database(request.env), request.user.id, since);

  return {
    nowPlaying: {
      entry: omitWhenEmpty(entries.map((entry) => nowPlayingEntryElement(entry, now))),
    },
  };
};

/**
 * `<entry>`, Navidrome's `NowPlayingEntry`: the `Child` (the song) with
 * `username`, `minutesAgo` and `playerName` after it, in that order.
 */
function nowPlayingEntryElement(entry: NowPlayingEntry, now: number): SubsonicNode {
  return {
    ...songElement(entry.song),
    username: entry.username,
    minutesAgo: Math.floor((now - entry.startedAt.getTime()) / 60_000),
    playerName: entry.playerName || undefined,
  };
}
