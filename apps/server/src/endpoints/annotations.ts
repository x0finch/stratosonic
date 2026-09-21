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
import { parseGoInt64, requiredIntegerParameter, requiredParameter } from "../subsonic/params";
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
 * by position; a missing or unreadable `time` means now.
 *
 * `id` is required (error 10) and must name a track that exists (error 70).
 */
export const scrobble: SubsonicHandler = async (request) => {
  const { params } = request;
  const ids = requestedTrackIds(params);
  const db = database(request.env);

  const missing = await findMissingItems(
    db,
    ids.map((id) => ({ type: "track", id })),
  );
  if (missing.length > 0) {
    throw new SubsonicError(SubsonicErrorCode.NotFound);
  }

  const times = params.getAll("time");
  const at = (index: number): Date => scrobbleTime(times[index]);

  if (isSubmission(params)) {
    // A play counts for the track and for its album, so `frequent`/`recent`
    // album lists reflect what was played; the album is looked up once.
    const albumOf = await findTrackAlbums(db, ids);
    const plays: Play[] = [];
    for (const [index, id] of ids.entries()) {
      const playDate = at(index);
      plays.push({ item: { type: "track", id }, playDate });

      const albumId = albumOf.get(id);
      if (albumId !== undefined) {
        plays.push({ item: { type: "album", id: albumId }, playDate });
      }
    }
    await recordPlays(db, request.user.id, plays);
  } else {
    const playerName = params.get("c") ?? "";
    for (const [index, id] of ids.entries()) {
      await registerNowPlaying(db, request.user.id, id, playerName, at(index));
    }
  }

  return {};
};

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

/** The instant a scrobbled play happened: the given epoch-ms `time`, or now. */
function scrobbleTime(value: string | undefined): Date {
  const parsed = value === undefined ? null : parseGoInt64(value);

  return parsed === null ? new Date() : new Date(Number(parsed));
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
