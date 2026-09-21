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
import { type AnnotatedItem, findMissingItems, setStarred } from "../annotations/repository";
import { database } from "../db";
import { SubsonicError, SubsonicErrorCode } from "../subsonic/response";
import type { AuthenticatedSubsonicRequest, SubsonicHandler } from "../subsonic/router";

/** `star` — starring the caller's songs, albums and artists. */
export const star: SubsonicHandler = (request) => setStars(request, true);

/** `unstar` — the reverse, on the same items. */
export const unstar: SubsonicHandler = (request) => setStars(request, false);

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
