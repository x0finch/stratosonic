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

import { parsePrefixedId } from "@stratosonic/db";
import {
  type AnnotatedItem,
  findMissingItems,
  setRating as saveRating,
  setStarred,
} from "../annotations/repository";
import { database } from "../db";
import { requiredIntegerParameter, requiredParameter } from "../subsonic/params";
import { SubsonicError, SubsonicErrorCode } from "../subsonic/response";
import type { AuthenticatedSubsonicRequest, SubsonicHandler } from "../subsonic/router";

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
 * that is not a whole number is error 0, as Navidrome's `req.Params.Int`
 * refuses one, and an id that names nothing is error 70.
 *
 * The 0–5 range, on the other hand, is ours: Navidrome reads `rating` with
 * `p.Int` and stores whatever comes back unchecked (`annUpsert` in
 * `persistence/sql_annotations.go`), so it accepts and keeps a 6. We refuse it
 * with error 0 because the protocol defines 0–5 and a stored 6 would have the
 * serializers emit an out-of-spec `userRating="6"` on every read of that item.
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
