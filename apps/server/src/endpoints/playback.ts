/**
 * The Playback-state module: what a client saves to resume a session — the
 * now-playing feed and the play queue here, and (next) bookmarks.
 */

import { parseIdOfType, prefixedId } from "@stratosonic/db";
import { database } from "../db";
import { findSongsByIds } from "../library/repository";
import {
  omitWhenEmpty,
  type SongView,
  songElement,
  subsonicTimestamp,
} from "../library/serializers";
import { listNowPlaying, type NowPlayingEntry } from "../nowplaying/repository";
import {
  clearPlayQueue,
  findPlayQueue,
  savePlayQueue as storePlayQueue,
} from "../playqueue/repository";
import { integerParameterOr } from "../subsonic/params";
import type { SubsonicNode } from "../subsonic/response";
import { SubsonicError, SubsonicErrorCode } from "../subsonic/response";
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

/**
 * `savePlayQueue` — the caller's queue, the track they are on and how far into
 * it, so another device can pick the session up.
 *
 * `id` is repeatable and carries the queue in order; `current` names the track
 * being played and `position` is milliseconds into it. The save replaces
 * whatever was stored — Navidrome clears the user's queue before storing the
 * new one, so nothing is merged — and **a call naming no track clears the
 * queue**, which is how a client says it has nothing queued.
 *
 * Nothing is checked against the library: a queue is what the client says it
 * is, and `getPlayQueue` leaves out the entries that no longer resolve. An id
 * that is not a track id at all is error 70, as it is everywhere a client
 * sends one.
 *
 * `position` follows Navidrome's `Int64Or`: absent or unreadable means 0
 * rather than a refusal.
 */
export const savePlayQueue: SubsonicHandler = async (request) => {
  const { params } = request;
  const db = database(request.env);
  const trackIds = params.getAll("id").map(queueTrackId);

  if (trackIds.length === 0) {
    await clearPlayQueue(db, request.user.id);

    return {};
  }

  const current = params.get("current");

  await storePlayQueue(db, request.user.id, {
    trackIds,
    current: current === null ? null : queueTrackId(current),
    position: integerParameterOr(params, "position", 0),
    changedBy: params.get("c") ?? "",
    changedAt: new Date(),
  });

  return {};
};

/**
 * `getPlayQueue` — the queue the caller last saved, ready to resume.
 *
 * The saved ids are resolved to `<entry>` songs in the order they were saved;
 * a track that has since left the library is left out rather than failing the
 * response, so a queue survives a rescan that removed one of its files. A
 * caller who has saved nothing gets an empty `<playQueue/>`, not an error, as
 * Navidrome answers.
 *
 * Only the caller's own queue is ever read: the row is keyed by user.
 */
export const getPlayQueue: SubsonicHandler = async (request) => {
  const db = database(request.env);
  const queue = await findPlayQueue(db, request.user.id);
  if (queue === null) {
    return { playQueue: {} };
  }

  const songs = await findSongsByIds(db, queue.trackIds, request.user.id);
  const entries = queue.trackIds
    .map((id) => songs.get(id))
    .filter((song): song is SongView => song !== undefined);

  return {
    playQueue: {
      current: queue.current === null ? undefined : prefixedId("track", queue.current),
      position: queue.position || undefined,
      username: request.user.userName,
      changed: subsonicTimestamp(queue.changedAt),
      changedBy: queue.changedBy,
      entry: omitWhenEmpty(entries.map(songElement)),
    },
  };
};

/** A queued track id as the client sent it; anything else is error 70. */
function queueTrackId(value: string): string {
  const id = parseIdOfType("track", value);
  if (id === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound);
  }

  return id;
}
