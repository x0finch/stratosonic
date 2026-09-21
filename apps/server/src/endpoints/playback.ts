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
 */
function bookmarkElement(entry: BookmarkEntry, userName: string): SubsonicNode {
  return {
    position: entry.position,
    username: userName,
    comment: entry.comment,
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
