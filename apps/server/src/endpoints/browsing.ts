/**
 * The Browsing module, ID3 flavour: the artist → album → track walk a client
 * takes through the library, plus the genre list.
 *
 * Every handler here reads rows through `library/repository` and renders them
 * with the shared element builders in `library/serializers`, so what a
 * `<song>` looks like is decided once for this module, for Lists, for folder
 * browsing and for Playlists.
 *
 * Two rules the whole module keeps:
 *
 * - **A bad id is "not found", not an error about ids.** A missing `id` is
 *   error 10 because the request cannot be understood at all; an id that is
 *   malformed, names nothing, or names the wrong kind of thing — a `tr-` id
 *   sent to `getArtist` — is error 70, the same answer a client gets for an
 *   entity that has been deleted, which is what it usually is.
 * - **An empty library is an empty answer, never a failure.** Navidrome
 *   replies to `getArtists` with error 70 ("Library not found or empty") when
 *   it has no artists; we answer with the empty container instead. A client
 *   meets this state on its very first sync, before the first scan has
 *   finished, and an error there can stop the sync altogether (#9).
 */

import { type EntityType, parseIdOfType } from "@stratosonic/db";
import { database } from "../db";
import { groupArtistsByIndex, IGNORED_ARTICLES } from "../library/artist-index";
import { checkMusicFolderIds } from "../library/music-folder";
import {
  findAlbum,
  findArtist,
  findTrack,
  listAlbumsOfArtist,
  listArtists,
  listGenres,
  listTracksOfAlbum,
} from "../library/repository";
import {
  albumElement,
  artistElement,
  genreElement,
  omitWhenEmpty,
  songElement,
} from "../library/serializers";
import { requiredParameter } from "../subsonic/params";
import { SubsonicError, SubsonicErrorCode } from "../subsonic/response";
import type { AuthenticatedSubsonicRequest, SubsonicHandler } from "../subsonic/router";

/**
 * The `id` of the entity an endpoint was asked about, as it is stored.
 *
 * The prefix has to name the kind the endpoint serves: an id of another kind
 * could be a real id of a real thing, and answering with that thing would
 * hand the client an `<artist>` where it asked for a song.
 */
function requestedId(
  request: AuthenticatedSubsonicRequest,
  type: EntityType,
  notFound: string,
): string {
  const id = parseIdOfType(type, requiredParameter(request.params, "id"));
  if (id === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound, notFound);
  }

  return id;
}

/**
 * `getArtists` — every artist, bucketed into `<index>` groups by the letter
 * they sort under, with the articles that were ignored to get there.
 *
 * A `musicFolderId` is checked even though this server has only one folder,
 * as Navidrome's `GetArtists` checks it through `selectedMusicFolderIds`
 * (server/subsonic/browsing.go): a client that asks for a folder we do not
 * have asked for something that is not there.
 */
export const getArtists: SubsonicHandler = async (request) => {
  checkMusicFolderIds(request.params);

  const artists = await listArtists(database(request.env), request.user.id);

  const index = groupArtistsByIndex(artists, (artist) => artist.name).map((group) => ({
    name: group.name,
    artist: group.artists.map(artistElement),
  }));

  return { artists: { ignoredArticles: IGNORED_ARTICLES, index: omitWhenEmpty(index) } };
};

/** `getArtist` — one artist and the albums it is the album artist of. */
export const getArtist: SubsonicHandler = async (request) => {
  const db = database(request.env);
  const id = requestedId(request, "artist", "Artist not found");

  const artist = await findArtist(db, id, request.user.id);
  if (artist === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound, "Artist not found");
  }

  const albums = await listAlbumsOfArtist(db, id, request.user.id);

  return { artist: { ...artistElement(artist), album: omitWhenEmpty(albums.map(albumElement)) } };
};

/** `getAlbum` — one album and its tracks, in the order the record plays. */
export const getAlbum: SubsonicHandler = async (request) => {
  const db = database(request.env);
  const id = requestedId(request, "album", "Album not found");

  const album = await findAlbum(db, id, request.user.id);
  if (album === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound, "Album not found");
  }

  const tracks = await listTracksOfAlbum(db, album, request.user.id);

  return { album: { ...albumElement(album), song: omitWhenEmpty(tracks.map(songElement)) } };
};

/** `getSong` — one track. */
export const getSong: SubsonicHandler = async (request) => {
  const id = requestedId(request, "track", "Song not found");

  const song = await findTrack(database(request.env), id, request.user.id);
  if (song === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound, "Song not found");
  }

  return { song: songElement(song) };
};

/** `getGenres` — every genre the library's tracks carry, with its counts. */
export const getGenres: SubsonicHandler = async (request) => {
  const genres = await listGenres(database(request.env));

  return { genres: { genre: omitWhenEmpty(genres.map(genreElement)) } };
};
