/**
 * The Search module: `search2` and `search3`, the two searches a client's
 * search box calls.
 *
 * Both read the same library and match it the same way (library/search.ts);
 * they differ only in how they render what they find, exactly as Navidrome's
 * `Search2` and `Search3` differ:
 *
 * - **`search3` speaks ID3** — `<artist>` is `ArtistID3` (with `albumCount`)
 *   and `<album>` is `AlbumID3`, the same elements `getArtist` and `getAlbum`
 *   answer with.
 * - **`search2` speaks the folder view** — `<artist>` is the plain `Artist`
 *   (id, name, cover; no count) and each `<album>` is a `<child>` directory,
 *   the shape `getMusicDirectory` lists an album as.
 * - **`<song>` is the same `Child`** in both.
 *
 * The children come in Navidrome's order — artist, album, song — and each kind
 * pages independently by its own `*Count`/`*Offset` parameters, defaulting to
 * 20 as Navidrome defaults them and capped at 500. The cap is this server's,
 * not Navidrome's, which caps no search count: a Worker builds the whole
 * response in memory out of rows D1 returns in one read, so an unbounded
 * `songCount` would let one request ask for the entire library at once, the
 * same reason the album lists cap their `size`. A result container is always
 * present, even when everything in it is empty, so an empty library answers
 * with an empty `<searchResult3/>` rather than an error (#9).
 */

import { database } from "../db";
import { type SearchQuery, type SearchWindow, searchLibrary } from "../library/search";
import {
  albumChildElement,
  albumElement,
  artistElement,
  indexArtistElement,
  omitWhenEmpty,
  songElement,
} from "../library/serializers";
import { integerParameterOr } from "../subsonic/params";
import { SubsonicError, SubsonicErrorCode } from "../subsonic/response";
import type { AuthenticatedSubsonicRequest, SubsonicHandler } from "../subsonic/router";

/** Each kind's default page size, matching Navidrome's `Search*` defaults. */
const DEFAULT_COUNT = 20;

/** The most one kind can carry, however large a `*Count` the client sends. */
const MAX_COUNT = 500;

/** `search3` — matches rendered as ID3 elements. */
export const search3: SubsonicHandler = async (request) => {
  const results = await searchLibrary(database(request.env), requestedSearch(request));

  return {
    searchResult3: {
      artist: omitWhenEmpty(results.artists.map(artistElement)),
      album: omitWhenEmpty(results.albums.map(albumElement)),
      song: omitWhenEmpty(results.tracks.map(songElement)),
    },
  };
};

/** `search2` — the same matches rendered as the folder view's elements. */
export const search2: SubsonicHandler = async (request) => {
  const results = await searchLibrary(database(request.env), requestedSearch(request));

  return {
    searchResult2: {
      artist: omitWhenEmpty(results.artists.map(indexArtistElement)),
      album: omitWhenEmpty(results.albums.map(albumChildElement)),
      song: omitWhenEmpty(results.tracks.map(songElement)),
    },
  };
};

/** The words to match and each kind's window, read in Navidrome's order. */
function requestedSearch(request: AuthenticatedSubsonicRequest): SearchQuery {
  const { params } = request;

  return {
    words: searchWords(params),
    artists: window(params, "artistCount", "artistOffset"),
    albums: window(params, "albumCount", "albumOffset"),
    songs: window(params, "songCount", "songOffset"),
  };
}

/**
 * The query, split into the words every match must contain.
 *
 * `query` is required — its absence is error 10 — but an *empty* query is a
 * request in its own right: it matches the whole library, which some clients
 * use to enumerate it. So the parameter has to be present, and only then may
 * it be empty; `requiredParameter` would reject the empty string as missing,
 * which is why the presence is checked directly here.
 *
 * One trailing `*` is dropped first, as Navidrome drops it
 * (`strings.TrimSuffix(q, "*")` in server/subsonic/searching.go): several
 * clients send `query=beat*` to mean a prefix search, and since every match is
 * already a substring the `*` carries no meaning — kept, it would be matched
 * literally and find nothing.
 */
function searchWords(params: URLSearchParams): string[] {
  if (!params.has("query")) {
    throw new SubsonicError(SubsonicErrorCode.MissingParameter, "missing parameter: 'query'");
  }

  const query = (params.get("query") ?? "").replace(/\*$/, "");

  return query.split(/\s+/).filter((word) => word.length > 0);
}

/**
 * One kind's window: its count (default 20, at most 500) and offset, neither
 * negative.
 */
function window(params: URLSearchParams, countName: string, offsetName: string): SearchWindow {
  const count = Math.max(integerParameterOr(params, countName, DEFAULT_COUNT), 0);

  return {
    count: Math.min(count, MAX_COUNT),
    offset: Math.max(integerParameterOr(params, offsetName, 0), 0),
  };
}
