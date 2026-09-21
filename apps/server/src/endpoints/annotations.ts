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
 * - **An item that names nothing is error 70.** An id that is malformed, or
 *   that resolves to no row of its kind, is "not found", the same answer
 *   browsing gives for a deleted item.
 * - **More than `MAX_ITEMS_PER_REQUEST` ids is error 0.** The work a request
 *   costs grows with the ids it names, and a Worker invocation on the free
 *   plan has fifty subrequests (a D1 query is one). The existence check takes
 *   `KEYS_PER_STATEMENT` ids of a kind at a time, so a thousand ids spread
 *   over the four kinds are at most ceil(1000 / 90) + 3 = 15 selects, and the
 *   writes are one batch however many there are: sixteen subrequests at the
 *   cap, well inside the budget. A client with more to star sends more
 *   requests.
 */

import { parsePrefixedId } from "@stratosonic/db";
import { type AnnotatedItem, findMissingItems, setStarred } from "../annotations/repository";
import { database } from "../db";
import { SubsonicError, SubsonicErrorCode } from "../subsonic/response";
import type { AuthenticatedSubsonicRequest, SubsonicHandler } from "../subsonic/router";

/** How many items one `star` or `unstar` may name, ids of all kinds together. */
const MAX_ITEMS_PER_REQUEST = 1000;

/** `star` — starring the caller's songs, albums, artists and playlists. */
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
 * entity, and our prefixed ids carry the kind with them. A playlist id is one
 * of them: Navidrome's `setStar` stars a playlist like anything else, and the
 * `annotation` table's `item_type` has always allowed it. Nothing renders that
 * star back yet, and nothing has to — Navidrome's `<playlist>` element carries
 * no `starred` attribute — so the row is written for the read side to pick up
 * whenever one wants it.
 *
 * A request with no ids at all is error 10; more than `MAX_ITEMS_PER_REQUEST`
 * of them is error 0, counted before anything is parsed; an id that does not
 * parse is error 70.
 */
function requestedItems(params: URLSearchParams): AnnotatedItem[] {
  const raw = [...params.getAll("id"), ...params.getAll("albumId"), ...params.getAll("artistId")];
  if (raw.length === 0) {
    throw new SubsonicError(SubsonicErrorCode.MissingParameter);
  }

  if (raw.length > MAX_ITEMS_PER_REQUEST) {
    throw new SubsonicError(
      SubsonicErrorCode.Generic,
      `too many ids: ${raw.length}, at most ${MAX_ITEMS_PER_REQUEST} per request`,
    );
  }

  return raw.map((value) => {
    const parsed = parsePrefixedId(value);
    if (parsed === null) {
      throw new SubsonicError(SubsonicErrorCode.NotFound);
    }

    return { type: parsed.type, id: parsed.id };
  });
}
