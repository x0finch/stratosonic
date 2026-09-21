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
 * - **An item that names nothing is error 70, and nothing is written.** An id
 *   that is malformed, or that resolves to no row of its kind, is "not
 *   found", the same answer browsing gives for a deleted item — and one such
 *   id refuses the whole request, leaving the ids beside it unstarred. That
 *   is a deliberate divergence from Navidrome, whose `setStar` skips the ids
 *   it cannot resolve and stars the rest; issue #40 asks for error 70, so a
 *   client is told rather than left to guess which of its ids took.
 * - **More than `MAX_ITEMS_PER_REQUEST` ids is error 0.** The work a request
 *   costs grows with the ids it names, and a Worker invocation on the free
 *   plan has fifty subrequests (a D1 query is one). The existence check takes
 *   `KEYS_PER_STATEMENT` ids of a kind at a time, so a thousand ids spread
 *   over the four kinds are at most ceil(1000 / 90) + 3 = 15 selects, and the
 *   writes are one batch however many there are: sixteen subrequests at the
 *   cap, well inside the budget. A client with more to star sends more
 *   requests.
 *
 *   `scrobble` is held to the same cap and for the same reason. A client
 *   flushing an offline backlog is the one caller that really does send
 *   hundreds of ids at once, and its submission path reads them in chunks
 *   too (`findTrackAlbums`), so a thousand ids are ceil(1000 / 90) = 12
 *   selects and one batch.
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

/**
 * The track ids of a `scrobble`: required, at most `MAX_ITEMS_PER_REQUEST` of
 * them, and each a real track id.
 */
function requestedTrackIds(params: URLSearchParams): string[] {
  const raw = params.getAll("id");
  if (raw.length === 0) {
    throw new SubsonicError(SubsonicErrorCode.MissingParameter, "missing parameter: 'id'");
  }

  if (raw.length > MAX_ITEMS_PER_REQUEST) {
    throw new SubsonicError(
      SubsonicErrorCode.Generic,
      `too many ids: ${raw.length}, at most ${MAX_ITEMS_PER_REQUEST} per request`,
    );
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

/**
 * How many items one write may name: for `star` and `unstar`, ids of all
 * kinds together; for `scrobble`, the tracks of one submission.
 */
const MAX_ITEMS_PER_REQUEST = 1000;

/** `star` — starring the caller's songs, albums, artists and playlists. */
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
  // Both parameters are read before the id is resolved, as Navidrome reads
  // them (p.String("id"), then p.Int("rating"), and only then the entity
  // lookup): a malformed id sent without a rating is answered for the missing
  // rating -- error 10 -- rather than for the id it never got to look up.
  const id = requiredParameter(request.params, "id");
  const rating = requestedRating(request.params);
  const item = annotatedItem(id);
  const db = database(request.env);

  const missing = await findMissingItems(db, [item]);
  if (missing.length > 0) {
    throw new SubsonicError(SubsonicErrorCode.NotFound);
  }

  await saveRating(db, request.user.id, item, rating);

  return {};
};

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
 * entity, and our prefixed ids carry the kind with them. A playlist id is one
 * of them: Navidrome's `setStar` stars a playlist like anything else, and the
 * `annotation` table's `item_type` has always allowed it. Nothing renders that
 * star back yet, and nothing has to — Navidrome's `<playlist>` element carries
 * no `starred` attribute — so the row is written for the read side to pick up
 * whenever one wants it.
 *
 * A request with no ids at all is error 10; more than `MAX_ITEMS_PER_REQUEST`
 * of them is error 0, counted before anything is parsed; what each id may be
 * is `annotatedItem`'s to say.
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

  return raw.map((value) => annotatedItem(value));
}

/**
 * The item one id names, for whichever endpoint carried it: the kind is the
 * id's prefix, and an id that does not parse at all is error 70 — "not
 * found", the same answer browsing gives for a deleted item.
 *
 * Every kind the `annotation` table holds is allowed through, playlists
 * included, because both endpoints that reach this write the same table and
 * Navidrome resolves an id to its entity without asking which endpoint
 * carried it. Whether the row the id names exists is `findMissingItems`'
 * question, not this one's.
 */
function annotatedItem(value: string): AnnotatedItem {
  const parsed = parsePrefixedId(value);
  if (parsed === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound);
  }

  return { type: parsed.type, id: parsed.id };
}
