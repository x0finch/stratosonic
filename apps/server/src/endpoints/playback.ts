/**
 * The Playback-state module: what a client saves to resume a session — the
 * now-playing feed, the play queue and the bookmarks.
 */

import { parseIdOfType, prefixedId } from "@stratosonic/db";
import { findMissingItems } from "../annotations/repository";
import {
  type BookmarkEntry,
  deleteBookmark as dropBookmark,
  listBookmarks,
  saveBookmark,
} from "../bookmarks/repository";
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
import {
  integerParameterOr,
  requiredIntegerParameter,
  requiredParameter,
} from "../subsonic/params";
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
 * More than `MAX_QUEUE_TRACKS` of them is error 0. The save itself is one
 * statement however long the queue, but reading it back is one `in (...)` per
 * `KEYS_PER_STATEMENT` ids, and a Worker invocation on the free plan has
 * fifty subrequests - so an unbounded queue would save happily and then be
 * unreadable, which is the worse of the two failures. At the cap a
 * `getPlayQueue` is thirteen subrequests. Navidrome stores whatever arrives,
 * having no such budget; `star` and `scrobble` carry the same kind of cap.
 *
 * `position` follows Navidrome's `Int64Or`: absent or unreadable means 0
 * rather than a refusal.
 */
export const savePlayQueue: SubsonicHandler = async (request) => {
  const { params } = request;
  const db = database(request.env);
  const raw = params.getAll("id");

  if (raw.length > MAX_QUEUE_TRACKS) {
    throw new SubsonicError(
      SubsonicErrorCode.Generic,
      `too many ids: ${raw.length}, at most ${MAX_QUEUE_TRACKS} per request`,
    );
  }

  const trackIds = raw.map(queueTrackId);

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

/**
 * How many tracks one saved queue may hold, so that reading it back stays
 * inside a free-plan invocation's subrequest budget.
 */
const MAX_QUEUE_TRACKS = 1000;

/** A queued track id as the client sent it; anything else is error 70. */
function queueTrackId(value: string): string {
  const id = parseIdOfType("track", value);
  if (id === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound);
  }

  return id;
}

/**
 * `getBookmarks` — every place the caller has marked, so a client can offer to
 * resume there.
 *
 * Each bookmark is the `<entry>` song plus the `position` in milliseconds, the
 * `comment` the client attached, the caller's `username` and the
 * `created`/`changed` pair. A caller with no bookmarks gets an empty
 * `<bookmarks/>`, as Navidrome answers.
 *
 * Only the caller's own bookmarks are read: the rows are keyed by user.
 */
export const getBookmarks: SubsonicHandler = async (request) => {
  const entries = await listBookmarks(database(request.env), request.user.id);

  return {
    bookmarks: {
      bookmark: omitWhenEmpty(
        entries.map((entry) => bookmarkElement(entry, request.user.userName)),
      ),
    },
  };
};

/**
 * `createBookmark` — the caller marks where they stopped in a track.
 *
 * `id` and `position` (milliseconds) are required, and `comment` is optional.
 * Bookmarking a track that is already bookmarked moves the place and replaces
 * the comment, keeping the instant the bookmark was first made — so a client
 * re-sending one is an update, not a failure.
 *
 * An `id` that names no track is error 70. Navidrome does not check: its
 * bookmark rows point at whatever id arrives, and a bookmark on a track that
 * does not exist is one no `getBookmarks` can ever show. Refusing it costs one
 * query and tells the client what happened.
 */
export const createBookmark: SubsonicHandler = async (request) => {
  const { params } = request;
  const trackId = bookmarkedTrackId(params);
  const position = requiredIntegerParameter(params, "position");
  const db = database(request.env);

  const missing = await findMissingItems(db, [{ type: "track", id: trackId }]);
  if (missing.length > 0) {
    throw new SubsonicError(SubsonicErrorCode.NotFound);
  }

  await saveBookmark(
    db,
    request.user.id,
    trackId,
    position,
    params.get("comment") ?? "",
    new Date(),
  );

  return {};
};

/**
 * `deleteBookmark` — the caller forgets where they stopped in a track.
 *
 * `id` is required, and a bookmark the caller does not have is error 70.
 * Navidrome deletes by `(user, item)` and says nothing when no row went, so a
 * client cannot tell a bookmark it never had from one it just removed; error
 * 70 is the answer this server gives everywhere else for something that is not
 * there.
 */
export const deleteBookmark: SubsonicHandler = async (request) => {
  const trackId = bookmarkedTrackId(request.params);

  const deleted = await dropBookmark(database(request.env), request.user.id, trackId);
  if (!deleted) {
    throw new SubsonicError(SubsonicErrorCode.NotFound);
  }

  return {};
};

/**
 * `<bookmark>`, Navidrome's `Bookmark`: the attributes it carries, and the
 * bookmarked song as its one `<entry>` child.
 *
 * `comment` is omitted when the client attached none, as Navidrome's
 * `omitempty` omits it; the other four are always sent, `position` included,
 * because a bookmark at 0 is still a bookmark. The column stores `""` for a
 * bookmark made without a comment, and a later one made with a comment
 * replaces it, so "no comment" and "the empty comment" are one state on both
 * servers.
 */
function bookmarkElement(entry: BookmarkEntry, userName: string): SubsonicNode {
  return {
    position: entry.position,
    username: userName,
    comment: entry.comment || undefined,
    created: subsonicTimestamp(entry.createdAt),
    changed: subsonicTimestamp(entry.changedAt),
    entry: songElement(entry.song),
  };
}

/** The track a bookmark names: required (error 10), and a track id (error 70). */
function bookmarkedTrackId(params: URLSearchParams): string {
  const id = parseIdOfType("track", requiredParameter(params, "id"));
  if (id === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound);
  }

  return id;
}
