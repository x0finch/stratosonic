/**
 * The Lists module: what a client asks for to fill its home screens and to
 * finish its first sync — album lists, a random handful of songs, and what the
 * caller has starred.
 *
 * Three rules hold across the module:
 *
 * - **A list a client's sync depends on answers with data, never an error.**
 *   An empty library, an empty `annotation` table and a list type whose data
 *   this server does not keep all produce a valid, empty container (#9).
 * - **`size` defaults to 10 and is capped at 500**, as Navidrome caps it
 *   (`min(p.IntOr("size", 10), 500)` in server/subsonic/album_lists.go), so a
 *   client cannot ask for the whole library in one request.
 * - **Parameters are read in Navidrome's order** — the list type and what that
 *   type needs, then `musicFolderId`, then the page — because that order
 *   decides which error a request with two problems gets.
 */

import { database } from "../db";
import {
  type AlbumListQuery,
  listAlbums,
  listRandomTracks,
  listStarred,
  type Page,
} from "../library/lists";
import { checkMusicFolderIds } from "../library/music-folder";
import { albumElement, artistElement, omitWhenEmpty, songElement } from "../library/serializers";
import {
  integerParameterOr,
  requiredIntegerParameter,
  requiredParameter,
} from "../subsonic/params";
import { SubsonicError, SubsonicErrorCode } from "../subsonic/response";
import type { AuthenticatedSubsonicRequest, SubsonicHandler } from "../subsonic/router";

/** How many items a list carries when the client does not say. */
const DEFAULT_SIZE = 10;

/** The most a list can carry however large a `size` the client sends. */
const MAX_SIZE = 500;

/**
 * The album-list types Navidrome supports whose data this server does not
 * keep: `recent` and `frequent` need play history, `highest` needs ratings,
 * and Phase 1 records none of it.
 *
 * They answer with an empty list rather than an error. Navidrome would answer
 * with rows; a client that meets an error here can stop syncing altogether
 * (#9), and "nothing has been played yet" is the truth anyway.
 */
const TYPES_WITHOUT_DATA = new Set(["recent", "frequent", "highest"]);

/**
 * `getAlbumList2` — one page of albums, chosen and ordered by `type`.
 *
 * An unknown type is error 0 with Navidrome's wording, which is what its
 * `getAlbumList` falls through to: a type nobody implements is a client bug,
 * and a silent empty list would hide it. The known-but-dataless types above
 * never reach that branch.
 */
export const getAlbumList2: SubsonicHandler = async (request) => {
  const query = requestedAlbumList(request);
  checkMusicFolderIds(request.params);
  const page = requestedPage(request.params);

  const albums = query === null ? [] : await listAlbums(database(request.env), query, page);

  return { albumList2: { album: omitWhenEmpty(albums.map(albumElement)) } };
};

/**
 * The list the request asks for, or `null` when it names a type this server
 * has no data for.
 *
 * Each branch reads exactly what its type needs, and does so before anything
 * else is validated — `byGenre` with no `genre` is error 10 whatever else the
 * request gets wrong, as it is in Navidrome.
 */
function requestedAlbumList(request: AuthenticatedSubsonicRequest): AlbumListQuery | null {
  const { params } = request;
  const type = requiredParameter(params, "type");

  switch (type) {
    case "newest":
    case "alphabeticalByName":
    case "alphabeticalByArtist":
    case "random":
      return { type };
    case "byGenre":
      return { type, genre: requiredParameter(params, "genre") };
    case "byYear":
      return {
        type,
        fromYear: requiredIntegerParameter(params, "fromYear"),
        toYear: requiredIntegerParameter(params, "toYear"),
      };
    case "starred":
      return { type, userId: request.user.id };
    default:
      if (TYPES_WITHOUT_DATA.has(type)) {
        return null;
      }

      throw new SubsonicError(SubsonicErrorCode.Generic, `type '${type}' not implemented`);
  }
}

/** The window the client asked for, within the bounds the server allows. */
function requestedPage(params: URLSearchParams): Page {
  return {
    size: boundedSize(params),
    // Navidrome applies an offset only when it is positive, so a negative one
    // is the same as none.
    offset: Math.max(integerParameterOr(params, "offset", 0), 0),
  };
}

/**
 * `size`, defaulted and capped.
 *
 * The lower bound is a deliberate departure: Navidrome passes its `Max`
 * straight to the query builder, which applies no `LIMIT` at all when it is
 * not positive, so `size=0` there means *the whole library*. On D1 that is a
 * request the free tier cannot afford to serve, and no client means it, so 0
 * means zero rows here.
 */
function boundedSize(params: URLSearchParams): number {
  const size = integerParameterOr(params, "size", DEFAULT_SIZE);

  return Math.min(Math.max(size, 0), MAX_SIZE);
}

/**
 * `getRandomSongs` — a random handful of tracks, optionally narrowed by genre
 * and by a year range, as Navidrome's `GetRandomSongs` narrows it.
 *
 * `fromYear` and `toYear` default to 0 there and are applied only when they
 * are something else, so a year of 0 is "no bound" rather than "the year 0".
 */
export const getRandomSongs: SubsonicHandler = async (request) => {
  const { params } = request;
  const size = boundedSize(params);
  const genre = params.get("genre") || null;
  const fromYear = integerParameterOr(params, "fromYear", 0) || null;
  const toYear = integerParameterOr(params, "toYear", 0) || null;
  checkMusicFolderIds(params);

  const tracks = await listRandomTracks(database(request.env), { genre, fromYear, toYear, size });

  return { randomSongs: { song: omitWhenEmpty(tracks.map(songElement)) } };
};

/**
 * `getStarred2` — the caller's starred artists, albums and songs.
 *
 * The caller's, and nobody else's: the annotation table is keyed by user, and
 * this reads only the rows of the account that authenticated. The children
 * come in Navidrome's order — `artist`, then `album`, then `song`
 * (responses.Starred2) — and an account that has starred nothing gets an
 * empty `<starred2/>`, which is the state every client starts in.
 */
export const getStarred2: SubsonicHandler = async (request) => {
  checkMusicFolderIds(request.params);

  const starred = await listStarred(database(request.env), request.user.id);

  return {
    starred2: {
      artist: omitWhenEmpty(starred.artists.map(artistElement)),
      album: omitWhenEmpty(starred.albums.map(albumElement)),
      song: omitWhenEmpty(starred.tracks.map(songElement)),
    },
  };
};
