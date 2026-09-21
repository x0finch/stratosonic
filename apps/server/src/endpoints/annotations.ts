/**
 * The Annotation module, write side: what a client saves about an item —
 * `star` and `unstar` here, `setRating` and `scrobble` alongside them.
 *
 * Every write is the caller's own (`annotations/repository.ts`), so a library
 * two accounts share keeps their stars apart. Each answers with an empty ok
 * envelope, as Navidrome does, and refuses a bad request before it writes:
 *
 * - **No item at all is error 10.** A `star` naming none of `id`, `albumId`
 *   or `artistId` cannot be acted on.
 * - **An item that names nothing is error 70.** An id that is malformed, of a
 *   kind that cannot be starred, or that resolves to no row is "not found",
 *   the same answer browsing gives for a deleted item.
 */

import { parseIdOfType, parsePrefixedId } from "@stratosonic/db";
import {
  type AnnotatedItem,
  findMissingItems,
  findTrackAlbums,
  type Play,
  recordPlays,
  setRating as saveRating,
  setStarred,
} from "../annotations/repository";
import { database } from "../db";
import { registerNowPlaying } from "../nowplaying/repository";
import {
  integerParameterValue,
  requiredIntegerParameter,
  requiredParameter,
} from "../subsonic/params";
import { SubsonicError, SubsonicErrorCode } from "../subsonic/response";
import type { AuthenticatedSubsonicRequest, SubsonicHandler } from "../subsonic/router";

/**
 * `scrobble` — a client tells the server the caller played a track.
 *
 * `submission=false` (a track starting) only registers the caller's
 * now-playing entry; `submission=true` (the default, a track finished) only
 * counts the play and moves its last-played instant. The two are exclusive, as
 * in Navidrome: a play does not touch now-playing, which expires by TTL, and a
 * now-playing does not count a play. `id` and `time` are repeatable and paired
 * by position; `time` is read only by a submission, and omitting it means now.
 *
 * `id` is required (error 10) and must name a track that exists (error 70). A
 * `time` that cannot be read, or a count of them that does not match the ids,
 * is error 0 — a request whose pairing is ambiguous is refused, not guessed at.
 */
export const scrobble: SubsonicHandler = async (request) => {
  const { params } = request;
  const ids = requestedTrackIds(params);
  const times = requestedTimes(params, ids.length);
  const db = database(request.env);

  if (isSubmission(params)) {
    // A play counts for the track and for its album, so `frequent`/`recent`
    // album lists reflect what was played. One query answers both questions
    // this path asks of `track` — which ids are real, and what album each one
    // belongs to — because an id the map does not carry is precisely a track
    // that is not in the library.
    const albumOf = await findTrackAlbums(db, ids);
    const now = new Date();
    const played = ids.map((id, index) => ({ id, playDate: times[index] ?? now }));
    if (played.some(({ id }) => !albumOf.has(id))) {
      throw new SubsonicError(SubsonicErrorCode.NotFound);
    }

    const trackPlays: Play[] = played.map(({ id, playDate }) => ({
      item: { type: "track", id },
      playDate,
    }));
    await recordPlays(db, request.user.id, [...trackPlays, ...albumPlays(played, albumOf)]);
  } else {
    const missing = await findMissingItems(
      db,
      ids.map((id) => ({ type: "track", id })),
    );
    if (missing.length > 0) {
      throw new SubsonicError(SubsonicErrorCode.NotFound);
    }

    // `now_playing` holds one row per user, so registering every id in turn
    // would leave only the last of them anyway — each write overwrites the row
    // the one before it made. A client that names several tracks is playing
    // the last: that is the only one written, in one statement.
    //
    // Its instant is the server's now, never the client's `time`. Navidrome
    // reads `time` for submissions alone, and a now-playing entry is measured
    // against this server's clock as it expires.
    const current = ids.at(-1);
    if (current !== undefined) {
      await registerNowPlaying(db, request.user.id, current, params.get("c") ?? "", new Date());
    }
  }

  return {};
};

/** One track a submission named, and when it was played. */
interface PlayedTrack {
  readonly id: string;
  readonly playDate: Date;
}

/**
 * The album side of a submission: one play row per album, however many of its
 * tracks the request named.
 *
 * A client that finishes a sync sends a whole album at once, and a row per
 * track would be as many statements — each overwriting the same album row — to
 * reach a count the request already knows. Grouping makes it one upsert per
 * album, adding that many plays and carrying the latest of their instants,
 * which is the one `recent` should order by.
 */
function albumPlays(played: readonly PlayedTrack[], albumOf: ReadonlyMap<string, string>): Play[] {
  const byAlbum = new Map<string, { playDate: Date; count: number }>();

  for (const { id, playDate } of played) {
    const albumId = albumOf.get(id);
    if (albumId === undefined) {
      continue;
    }

    const current = byAlbum.get(albumId);
    byAlbum.set(albumId, {
      playDate: current && current.playDate > playDate ? current.playDate : playDate,
      count: (current?.count ?? 0) + 1,
    });
  }

  return [...byAlbum].map(([id, { playDate, count }]) => ({
    item: { type: "album", id },
    playDate,
    count,
  }));
}

/** The track ids of a `scrobble`: required, and each a real track id. */
function requestedTrackIds(params: URLSearchParams): string[] {
  const raw = params.getAll("id");
  if (raw.length === 0) {
    throw new SubsonicError(SubsonicErrorCode.MissingParameter, "missing parameter: 'id'");
  }

  return raw.map((value) => {
    const id = parseIdOfType("track", value);
    if (id === null) {
      throw new SubsonicError(SubsonicErrorCode.NotFound);
    }

    return id;
  });
}

/** Whether this is a play submission (the default) rather than a now-playing. */
function isSubmission(params: URLSearchParams): boolean {
  const value = (params.get("submission") ?? "").toLowerCase();

  return value !== "false" && value !== "0";
}

/**
 * The instants a `scrobble` names, one per id — or none, which is the
 * ordinary case and means every play happened now.
 *
 * `time` is repeatable and paired with `id` by position, so a request that
 * sends a different number of each cannot be acted on: Navidrome answers
 * "Wrong number of timestamps" rather than guessing which play an instant
 * belongs to. An epoch-ms value that is not a whole number is an invalid
 * parameter, as it is everywhere else, not a silent "now".
 */
function requestedTimes(params: URLSearchParams, idCount: number): Date[] {
  const raw = params.getAll("time");
  if (raw.length === 0) {
    return [];
  }

  if (raw.length !== idCount) {
    throw new SubsonicError(
      SubsonicErrorCode.Generic,
      `Wrong number of timestamps: ${raw.length}, should be ${idCount}`,
    );
  }

  return raw.map((value) => new Date(integerParameterValue("time", value)));
}

/** `star` — starring the caller's songs, albums and artists. */
export const star: SubsonicHandler = (request) => setStars(request, true);

/** `unstar` — the reverse, on the same items. */
export const unstar: SubsonicHandler = (request) => setStars(request, false);

/** The highest rating the protocol allows; 0 clears a rating. */
const MAX_RATING = 5;

/**
 * `setRating` — the caller rates one song, album or artist from 1 to 5, or
 * clears it with 0.
 *
 * The item and the rating are both required (error 10 when absent). A rating
 * that is not a whole number, or is outside 0–5, is error 0 — Navidrome
 * refuses the same range — and an id that names nothing is error 70.
 */
export const setRating: SubsonicHandler = async (request) => {
  const item = requestedItem(request.params);
  const rating = requestedRating(request.params);
  const db = database(request.env);

  const missing = await findMissingItems(db, [item]);
  if (missing.length > 0) {
    throw new SubsonicError(SubsonicErrorCode.NotFound);
  }

  await saveRating(db, request.user.id, item, rating);

  return {};
};

/** The one item `setRating` names, by its id's prefix. */
function requestedItem(params: URLSearchParams): AnnotatedItem {
  const parsed = parsePrefixedId(requiredParameter(params, "id"));
  if (parsed === null || parsed.type === "playlist") {
    throw new SubsonicError(SubsonicErrorCode.NotFound);
  }

  return { type: parsed.type, id: parsed.id };
}

/** The rating, required and within 0–5. */
function requestedRating(params: URLSearchParams): number {
  const rating = requiredIntegerParameter(params, "rating");
  if (rating < 0 || rating > MAX_RATING) {
    throw new SubsonicError(
      SubsonicErrorCode.Generic,
      `rating must be between 0 and ${MAX_RATING}, got ${rating}`,
    );
  }

  return rating;
}

async function setStars(request: AuthenticatedSubsonicRequest, starred: boolean) {
  const items = requestedItems(request.params);
  const db = database(request.env);

  const missing = await findMissingItems(db, items);
  if (missing.length > 0) {
    throw new SubsonicError(SubsonicErrorCode.NotFound);
  }

  await setStarred(db, request.user.id, items, starred, new Date());

  return {};
}

/**
 * The items a `star`/`unstar` names, from `id`, `albumId` and `artistId`
 * together.
 *
 * The item's kind comes from the id's prefix, not from which parameter carried
 * it — Navidrome concatenates the three lists and resolves each id to its
 * entity, and our prefixed ids carry the kind with them. A request with no ids
 * at all is error 10; an id that does not parse, or names a playlist (which
 * these endpoints do not star), is error 70.
 */
function requestedItems(params: URLSearchParams): AnnotatedItem[] {
  const raw = [...params.getAll("id"), ...params.getAll("albumId"), ...params.getAll("artistId")];
  if (raw.length === 0) {
    throw new SubsonicError(SubsonicErrorCode.MissingParameter);
  }

  return raw.map((value) => {
    const parsed = parsePrefixedId(value);
    if (parsed === null || parsed.type === "playlist") {
      throw new SubsonicError(SubsonicErrorCode.NotFound);
    }

    return { type: parsed.type, id: parsed.id };
  });
}
