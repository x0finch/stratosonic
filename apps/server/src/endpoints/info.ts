/**
 * The info endpoints: `getArtistInfo`, `getArtistInfo2`, `getAlbumInfo` and
 * `getAlbumInfo2` — what a client shows beside an artist's or an album's page
 * — and `getSimilarSongs`/`getSimilarSongs2`, the "more like this" mix a
 * client starts from one.
 *
 * Navidrome fills these from its external agents (Last.fm, Spotify, Deezer)
 * and caches what they say; with no agent configured it still answers them,
 * from local data alone, and that is the answer reproduced here, because
 * Stratosonic makes no outbound calls (ADR-0004). What Navidrome does, read
 * from its source:
 *
 * - `GetArtistInfo`/`GetArtistInfo2`/`GetAlbumInfo` (server/subsonic/
 *   browsing.go) build the element from what `UpdateArtistInfo` and
 *   `UpdateAlbumInfo` (core/external/provider.go) return. Every field an
 *   agent would fill — `biography`, `lastFmUrl`, `notes`, `similarArtist` —
 *   stays empty with only the local agent (core/agents/local_agent.go, which
 *   implements none of those retrievers), and Go's `omitempty` drops it
 *   (`ArtistInfoBase`, `ArtistInfo`, `ArtistInfo2`, `AlbumInfo` in
 *   server/subsonic/responses/responses.go). So `<artistInfo/>` has no
 *   `similarArtist` at all, whatever `count` and `includeNotPresent` ask for,
 *   and those two parameters change nothing — Navidrome reads them with
 *   `IntOr`/`BoolOr`, which cannot fail, so they are not read here.
 * - `musicBrainzId` is the tagged MBID (`MbzArtistID`, `MbzAlbumID`), local
 *   data; Stratosonic does not store MBIDs, so it is always left out.
 * - The three image URLs are *not* the agents': they are built for the
 *   entity's own artwork, at 300, 600 and 1200 pixels, whenever the entity
 *   has any (`if !artist.ImageAbsent`). Navidrome points them at its public
 *   image endpoint with a signed token (`publicurl.ImageURL`, core/publicurl/
 *   publicurl.go). Stratosonic serves artwork only through `getCoverArt`, so
 *   they point there instead — see `coverArtUrl` for how.
 * - `getAlbumInfo2` is the same handler as `getAlbumInfo` in Navidrome's
 *   router (server/subsonic/api.go), and both answer `<albumInfo>`, as the
 *   Subsonic spec has it.
 *
 * Which ids are accepted is Navidrome's too: `getArtist` in core/external/
 * provider.go takes an artist, and follows a song or an album to its artist;
 * `getAlbum` takes an album and follows a song to its album. Anything else —
 * a playlist, an artist sent to `getAlbumInfo`, an id that names nothing or
 * is malformed — is `ErrNotFound`, which `mapToSubsonicError` turns into error
 * 70 with the message "data not found". A missing `id` is error 10.
 *
 * Each info request is authentication plus one statement, and writes
 * nothing: Navidrome stores the (empty) agent answer and a timestamp on the
 * row, which is a cache of calls this server never makes.
 *
 * The similar songs are what Navidrome's local agent recommends, mixed as
 * its provider mixes them — library/similar-songs.ts says what each kind of
 * id gets, from core/external/provider_similarsongs.go and core/agents/
 * local_agent.go. The endpoints themselves are `GetSimilarSongs` and
 * `GetSimilarSongs2` (server/subsonic/browsing.go): `id` is required, `count`
 * defaults to 50, a count that is not positive is an empty list before the id
 * is even looked up, and the mix is capped at 500. An id is accepted for a
 * song, an album, an artist or a playlist the caller may see; anything else
 * is error 70. Navidrome also takes a genre id, which it mints and
 * Stratosonic does not — a genre here is only its name — so no id can name
 * one. `getSimilarSongs2` answers the same songs under `<similarSongs2>`.
 * Authentication plus at most two statements, and nothing written.
 */

import { type EntityId, parsePrefixedId, prefixedId } from "@stratosonic/db";
import { database } from "../db";
import { findAlbumFor, findArtistFor } from "../library/info";
import { omitWhenEmpty, type SongView, songElement } from "../library/serializers";
import { similarSongs } from "../library/similar-songs";
import { requiredParameter } from "../subsonic/params";
import {
  SubsonicError,
  SubsonicErrorCode,
  type SubsonicNode,
  TextElement,
} from "../subsonic/response";
import type { AuthenticatedSubsonicRequest, SubsonicHandler } from "../subsonic/router";
import { boundedCount } from "./lists";

/** How many similar songs a client gets when it does not say: `p.IntOr("count", 50)`. */
const DEFAULT_SIMILAR_SONGS_COUNT = 50;

/** Navidrome's message for `model.ErrNotFound` (`mapToSubsonicError`). */
const DATA_NOT_FOUND = "data not found";

/** The sizes of the small, medium and large image, as `publicurl.ImageURL` is asked for them. */
const IMAGE_SIZES = { smallImageUrl: 300, mediumImageUrl: 600, largeImageUrl: 1200 } as const;

/**
 * The parameters a `getCoverArt` URL carries so that it authenticates as the
 * caller: the ones `authenticate` and the required-parameter check read.
 */
const CREDENTIAL_PARAMETERS = ["u", "t", "s", "p", "v", "c"] as const;

/** The entity the `id` names: error 10 when it is missing, 70 when it is not an id. */
function requestedEntity(request: AuthenticatedSubsonicRequest): EntityId {
  const entity = parsePrefixedId(requiredParameter(request.params, "id"));
  if (entity === null) {
    throw notFound();
  }

  return entity;
}

/** Error 70 as Navidrome words it for every id that resolves to nothing. */
function notFound(): SubsonicError {
  return new SubsonicError(SubsonicErrorCode.NotFound, DATA_NOT_FOUND);
}

/** `getArtistInfo` — Navidrome's `ArtistInfo`, whose `similarArtist` is `Artist`. */
export const getArtistInfo: SubsonicHandler = async (request) => ({
  artistInfo: await artistInfo(request),
});

/** `getArtistInfo2` — the same, as `ArtistInfo2`, whose `similarArtist` is `ArtistID3`. */
export const getArtistInfo2: SubsonicHandler = async (request) => ({
  artistInfo2: await artistInfo(request),
});

/**
 * What both artist-info endpoints answer: `ArtistInfoBase`, and no
 * `similarArtist`, since only an agent could name one.
 *
 * The cover-art id is the one the `<artist>` element carries — the album
 * whose cover stands for the artist (CONTEXT.md) — where Navidrome signs its
 * own `ar-` artwork id; the picture behind the two is the same one.
 */
async function artistInfo(request: AuthenticatedSubsonicRequest): Promise<SubsonicNode> {
  const artist = await findArtistFor(database(request.env), requestedEntity(request));
  if (artist === null) {
    throw notFound();
  }

  return imageUrls(
    request,
    artist.coverAlbumId === null ? null : prefixedId("album", artist.coverAlbumId),
  );
}

/**
 * `getAlbumInfo` and `getAlbumInfo2` — Navidrome's `AlbumInfo`: nothing but
 * the image URLs, since `notes` and `lastFmUrl` come from an agent.
 */
export const getAlbumInfo: SubsonicHandler = async (request) => {
  const album = await findAlbumFor(database(request.env), requestedEntity(request));
  if (album === null) {
    throw notFound();
  }

  return {
    albumInfo: imageUrls(request, album.coverKey === null ? null : prefixedId("album", album.id)),
  };
};

/** `getSimilarSongs` — Navidrome's `SimilarSongs`, a list of `<song>`. */
export const getSimilarSongs: SubsonicHandler = async (request) => ({
  similarSongs: { song: omitWhenEmpty((await similarSongsOf(request)).map(songElement)) },
});

/** `getSimilarSongs2` — the same songs, as Navidrome's `SimilarSongs2`. */
export const getSimilarSongs2: SubsonicHandler = async (request) => ({
  similarSongs2: { song: omitWhenEmpty((await similarSongsOf(request)).map(songElement)) },
});

/**
 * The mix both similar-songs endpoints answer, read in Navidrome's order: the
 * `id` first, so a request without one is error 10 whatever its count; then
 * the count, where one that is not positive is an empty answer without a
 * lookup (`if count <= 0 { return nil, nil }` comes before `GetEntityByID`).
 */
async function similarSongsOf(request: AuthenticatedSubsonicRequest): Promise<SongView[]> {
  const id = requiredParameter(request.params, "id");
  const count = boundedCount(request.params, "count", DEFAULT_SIMILAR_SONGS_COUNT);
  if (count === 0) {
    return [];
  }

  const entity = parsePrefixedId(id);
  const songs =
    entity === null ? null : await similarSongs(database(request.env), request.user, entity, count);
  if (songs === null) {
    throw notFound();
  }

  return songs;
}

/**
 * The `smallImageUrl`, `mediumImageUrl` and `largeImageUrl` elements, in
 * `ArtistInfoBase`'s and `AlbumInfo`'s order, or none of them when the
 * entity has no artwork — Navidrome's `if !ImageAbsent`.
 */
function imageUrls(request: AuthenticatedSubsonicRequest, coverArtId: string | null): SubsonicNode {
  if (coverArtId === null) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(IMAGE_SIZES).map(([element, size]) => [
      element,
      new TextElement(coverArtUrl(request, coverArtId, size)),
    ]),
  );
}

/**
 * An absolute `getCoverArt` URL for this cover at this size.
 *
 * The address is the one the client reached this server at, worked out as
 * Navidrome's `ServerAddress` (server/middlewares.go) works it out for
 * `publicurl.AbsoluteURL`: the first `X-Forwarded-Host`, else the request's
 * own host, and `X-Forwarded-Proto`, else `X-Forwarded-Scheme`, else the
 * request's own scheme. On Workers the request URL already carries the public
 * host and scheme, so the headers matter only behind a further proxy.
 *
 * Navidrome's URL needs no credentials: it names a public endpoint and a
 * token signed for that one image. `getCoverArt` is authenticated like every
 * other endpoint, so this URL carries the caller's own credential parameters
 * instead — what gonic does for the same URLs (`genArtistCoverURL`,
 * server/ctrlsubsonic/handlers_by_tags.go), minus the parameters that are
 * not credentials. They are the caller's, handed back to the caller, from the
 * query or the form body alike.
 */
function coverArtUrl(request: AuthenticatedSubsonicRequest, coverArtId: string, size: number) {
  const url = new URL("/rest/getCoverArt", serverOrigin(request.raw));
  url.searchParams.set("id", coverArtId);
  url.searchParams.set("size", String(size));

  for (const name of CREDENTIAL_PARAMETERS) {
    const value = request.params.get(name);
    if (value !== null) {
      url.searchParams.set(name, value);
    }
  }

  return url.toString();
}

/** The scheme and host a client used to reach this server, as Navidrome's `ServerAddress` reads them. */
function serverOrigin(raw: Request): string {
  const own = new URL(raw.url);
  const host = raw.headers.get("X-Forwarded-Host")?.split(",")[0] || own.host;
  const scheme =
    raw.headers.get("X-Forwarded-Proto") ||
    raw.headers.get("X-Forwarded-Scheme") ||
    own.protocol.slice(0, -1);

  // A forwarded value that is not a host or a scheme cannot make an absolute
  // URL; the request's own address is then the one address known to work.
  return URL.canParse(`${scheme}://${host}`) ? `${scheme}://${host}` : own.origin;
}
