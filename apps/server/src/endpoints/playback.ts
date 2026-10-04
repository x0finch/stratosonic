/**
 * The Playback-state module: what a client saves to resume a session — the
 * now-playing feed, the play queue and the bookmarks.
 *
 * The queue and the bookmarks keep to the caller's libraries (#84): what is
 * out of them is left out of a read, dropped from a saved queue, and refused
 * by `createBookmark` as an unknown track is. The now-playing feed does not,
 * as Navidrome's does not.
 */

import { parseIdOfType, prefixedId } from "@stratosonic/db";
import { findMissingItems } from "../annotations/repository";
import {
  type BookmarkEntry,
  deleteBookmark as dropBookmark,
  listBookmarks,
  saveBookmark,
} from "../bookmarks/repository";
import { type Database, database } from "../db";
import { findSongsByIds } from "../library/repository";
import { type LibraryScope, scopeOf } from "../library/scope";
import {
  omitWhenEmpty,
  type SongView,
  songElement,
  subsonicTimestamp,
} from "../library/serializers";
import { listNowPlaying, type NowPlayingEntry } from "../nowplaying/repository";
import { estimatedPositionMs } from "../nowplaying/session";
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
 * `getNowPlaying` — who is currently listening, across every account.
 *
 * Only sessions whose expiry has not passed come back, so a track a listener
 * stopped hearing drops out on its own; the expiry is stored with the
 * session (`nowplaying/session.ts`). Each entry is the `<song>` plus
 * Navidrome's `NowPlayingEntry` attributes: the listener's `username`, how
 * long ago the session began (`minutesAgo`), a `playerId`, the `playerName`
 * the client sent, and the `playbackReport` extension's `state`, `positionMs`
 * and `playbackRate`.
 */
export const getNowPlaying: SubsonicHandler = async (request) => {
  const now = Date.now();
  const entries = await listNowPlaying(database(request.env), request.user.id, new Date(now));

  return {
    nowPlaying: {
      entry: omitWhenEmpty(
        entries.map((entry, index) => nowPlayingEntryElement(entry, index, now)),
      ),
    },
  };
};

/**
 * `<entry>`, Navidrome's `NowPlayingEntry`: the `Child` (the song) with
 * `username`, `minutesAgo`, `playerId`, `playerName`, `state`, `positionMs`
 * and `playbackRate` after it, in that order.
 *
 * `playerId` is required by the XSD and Navidrome numbers the entries of the
 * feed from 1, in the order it lists them — it has no player registry to
 * name — so this does the same. `positionMs` is where a playing session is by
 * now, moved on from its last report at its rate and capped at the track's
 * end, as Navidrome's `GetNowPlaying` estimates it; a starting or paused one
 * is where it was reported.
 */
function nowPlayingEntryElement(entry: NowPlayingEntry, index: number, now: number): SubsonicNode {
  const { session, song } = entry;

  return {
    ...songElement(song),
    username: entry.username,
    // Truncated toward zero, as Go's `int32(d.Minutes())` truncates.
    minutesAgo: Math.trunc((now - session.startedAt.getTime()) / 60_000),
    playerId: index + 1,
    playerName: session.playerName || undefined,
    state: session.state,
    positionMs: estimatedPositionMs(session, song.duration, now),
    playbackRate: session.playbackRate,
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
 * **A caller who does not see every library has their queue kept to it**
 * (#84): every id that names no track in their libraries is dropped, an
 * unknown one and one in a library they cannot see alike, so the save never
 * tells the two apart, and the rest is saved; `current` is dropped unless
 * it is one of the ids kept. Nothing is refused: a client's local queue can
 * hold a track a rescan removed, and refusing the whole save for it would
 * stop a client that saves on a timer from syncing, silently. That departs
 * from #84's error 70 on purpose, and is Navidrome's tolerance (it checks
 * nothing) in the shape of its `keepAccessible`. A save left with no track
 * clears the queue, as one naming none does. A caller who sees every
 * library has nothing to drop, and their save is v0.5.0's one statement.
 * The lookup (`findMissingItems`) takes 90 ids a select, less one for each
 * library the scope lists (at most 20).
 *
 * More than `MAX_QUEUE_TRACKS` of them is error 0. The save itself is one
 * statement however long the queue, but reading it back is one `in (...)` per
 * `KEYS_PER_STATEMENT` ids, and a Worker invocation on the free plan has
 * fifty subrequests - so an unbounded queue would save happily and then be
 * unreadable, which is the worse of the two failures. At the cap, counting
 * the statement that authenticates the caller, a `getPlayQueue` is fourteen
 * subrequests, and seventeen for a caller whose scope lists twenty
 * libraries, as is that caller's `savePlayQueue` (15 lookups and the save).
 * Navidrome stores whatever arrives, having no such budget; `star` and
 * `scrobble` carry the same kind of cap.
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

  const requested = raw.map(queueTrackId);
  const requestedCurrent = params.get("current");
  const asked = requestedCurrent === null ? null : queueTrackId(requestedCurrent);

  const scope = scopeOf(request.user);
  const trackIds = scope.all ? requested : await visibleTracks(db, requested, scope);
  const current = scope.all || asked === null || trackIds.includes(asked) ? asked : null;

  if (trackIds.length === 0) {
    await clearPlayQueue(db, request.user.id);

    return {};
  }

  await storePlayQueue(db, request.user.id, {
    trackIds,
    current,
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
 * response, so a queue survives a rescan that removed one of its files, and
 * so is a track in a library the caller no longer sees. `current` is left
 * out too when it names no entry answered, so a client never resumes on a
 * track it was not given. A
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

  const songs = await findSongsByIds(db, queue.trackIds, request.user.id, scopeOf(request.user));
  const entries = queue.trackIds
    .map((id) => songs.get(id))
    .filter((song): song is SongView => song !== undefined);

  return {
    playQueue: {
      current:
        queue.current === null || !songs.has(queue.current)
          ? undefined
          : prefixedId("track", queue.current),
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

/**
 * The ids, in order and with their repeats, that name a track in the scope:
 * one `findMissingItems` lookup per chunk of distinct ids.
 */
async function visibleTracks(
  db: Database,
  ids: readonly string[],
  scope: LibraryScope,
): Promise<string[]> {
  const missing = await findMissingItems(
    db,
    [...new Set(ids)].map((id) => ({ type: "track", id })),
    scope,
  );
  const dropped = new Set(missing.map((item) => item.id));

  return ids.filter((id) => !dropped.has(id));
}

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
  const entries = await listBookmarks(
    database(request.env),
    request.user.id,
    scopeOf(request.user),
  );

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
 * An `id` that names no track in the caller's libraries is error 70, with
 * nothing written. Navidrome does not check an unknown id: its
 * bookmark rows point at whatever id arrives, and a bookmark on a track that
 * does not exist is one no `getBookmarks` can ever show. Refusing it costs one
 * query and tells the client what happened.
 */
export const createBookmark: SubsonicHandler = async (request) => {
  const { params } = request;
  const trackId = bookmarkedTrackId(params);
  const position = requiredIntegerParameter(params, "position");
  const db = database(request.env);

  const missing = await findMissingItems(
    db,
    [{ type: "track", id: trackId }],
    scopeOf(request.user),
  );
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
