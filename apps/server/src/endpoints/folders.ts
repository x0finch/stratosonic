/**
 * The Browsing module, folder flavour: the same library as `getArtists` and
 * friends, seen by a client that walks folders instead of ID3 tags.
 *
 * There is nothing to walk on disk — the library is R2 objects indexed into
 * D1 — so the folder tree is synthesized the way Navidrome synthesizes it
 * (server/subsonic/browsing.go): one music folder holding every artist as a
 * directory, each artist holding its albums as sub-directories, and each
 * album holding its tracks. The rows and the element builders are the ones
 * the ID3 endpoints already use, so both views of the library agree on names,
 * ids, covers and order by construction.
 *
 * Three rules this module keeps, on top of the two the ID3 module states:
 *
 * - **`isDir` is a literal `true`/`false`.** An album directory says `true`,
 *   a track says `false`, and neither says 0 or 1 (#9's client traps).
 * - **A `musicFolderId` this server does not have is error 70**, never a
 *   silent fallback to the whole library.
 * - **An empty library is an empty `<indexes>`**, as it is an empty
 *   `<artists>` in the ID3 module: Navidrome answers error 70 there, and a
 *   client that meets that on its first sync can stop syncing altogether.
 */

import { parsePrefixedId, prefixedId } from "@stratosonic/db";
import { database } from "../db";
import { groupArtistsByIndex, IGNORED_ARTICLES } from "../library/artist-index";
import { checkMusicFolderIds, musicFolderElement } from "../library/music-folder";
import {
  findAlbum,
  findArtist,
  listAlbumsOfArtist,
  listArtists,
  listTracksOfAlbum,
} from "../library/repository";
import {
  type ArtistView,
  albumChildElement,
  omitWhenEmpty,
  songElement,
} from "../library/serializers";
import { requiredParameter } from "../subsonic/params";
import {
  SubsonicError,
  SubsonicErrorCode,
  type SubsonicNode,
  type SubsonicValue,
} from "../subsonic/response";
import type { SubsonicHandler } from "../subsonic/router";

/** Navidrome's message for every id `getMusicDirectory` cannot serve. */
const DIRECTORY_NOT_FOUND = "Directory not found";

/**
 * `getMusicFolders` — the library, as the one folder it is. A client asks for
 * this list before anything else and then passes an id from it back as
 * `musicFolderId`.
 */
export const getMusicFolders: SubsonicHandler = () => ({
  musicFolders: { musicFolder: [musicFolderElement()] },
});

/**
 * When the library last changed, in epoch milliseconds, for `<indexes>` to
 * report and for `ifModifiedSince` to be compared against.
 *
 * Navidrome reads the *last scan start time* out of its `property` table and
 * — this is the case we are in — **falls back to `time.Now()` when nothing
 * has recorded one yet** (`getArtist` in server/subsonic/browsing.go).
 * Stratosonic's scan does not exist yet (#11) and writes no such property, so
 * the fallback is all there is, and it is also the safe answer: a library that
 * says it changed just now is never skipped by a client's conditional
 * request, which is what a client doing its first sync needs. When the scan
 * lands it should store its start time and this should read it, at which
 * point `ifModifiedSince` starts saving real work.
 */
function libraryLastModified(): number {
  return Date.now();
}

/** 1970-01-02, the earliest instant Navidrome accepts as a real timestamp. */
const EARLIEST_MODIFIED_SINCE = 86_400_000;

/**
 * `ifModifiedSince` as Navidrome reads it (`req.Values.TimeOr`): epoch
 * milliseconds, where an absent value, `-1`, anything that is not an integer,
 * and any instant before 1970-01-02 all mean "no condition" — the zero time,
 * which every library modification is after.
 */
function ifModifiedSince(params: URLSearchParams): number {
  const value = params.get("ifModifiedSince");
  if (value === null || value === "" || value === "-1" || !/^[+-]?\d+$/.test(value)) {
    return 0;
  }

  const since = Number(value);

  return Number.isSafeInteger(since) && since >= EARLIEST_MODIFIED_SINCE ? since : 0;
}

/**
 * `getIndexes` — every artist as a directory, in the same `<index>` buckets
 * `getArtists` uses, so the two views of the library are navigated the same
 * way.
 *
 * `lastModified` and `ignoredArticles` are always answered. The artists are
 * left out when the client's `ifModifiedSince` is at or after them, which is
 * Navidrome's short circuit: its `getArtist` never touches the artist
 * repository unless the last scan is strictly after the instant the client
 * sent, and renders the empty index list that follows.
 */
export const getIndexes: SubsonicHandler = async (request) => {
  checkMusicFolderIds(request.params);

  const lastModified = libraryLastModified();
  const unchanged = lastModified <= ifModifiedSince(request.params);
  const artists = unchanged ? [] : await listArtists(database(request.env));

  const index = groupArtistsByIndex(artists, (artist) => artist.name).map((group) => ({
    name: group.name,
    artist: group.artists.map(indexArtistElement),
  }));

  return {
    indexes: {
      lastModified,
      ignoredArticles: IGNORED_ARTICLES,
      index: omitWhenEmpty(index),
    },
  };
};

/**
 * `<artist>` inside an `<index>`, Navidrome's `responses.Artist` as `toArtist`
 * fills it: id, name and the cover it borrows from its albums — and no
 * `albumCount`, which that element does not have. `artistImageUrl` is left
 * out because it is an absolute URL to an endpoint Stratosonic does not serve;
 * a client falls back to `coverArt`, which is the trap #9 names (artist images
 * only via `coverArt`).
 */
function indexArtistElement(artist: ArtistView): SubsonicNode {
  return {
    id: prefixedId("artist", artist.id),
    name: artist.name,
    coverArt: artist.coverAlbumId === null ? undefined : prefixedId("album", artist.coverAlbumId),
  };
}

/**
 * `getMusicDirectory` — one directory and its children: an artist's albums, or
 * an album's tracks.
 *
 * Navidrome resolves the id to whatever entity it names and answers
 * "Directory not found" for anything that is neither an artist nor an album,
 * so a track id, a playlist id, an id of nothing, and an id that could not
 * have been minted here all get the same error 70. A *missing* `id` is error
 * 10, as it is on every other endpoint in this server.
 */
export const getMusicDirectory: SubsonicHandler = async (request) => {
  const db = database(request.env);
  const asked = parsePrefixedId(requiredParameter(request.params, "id"));

  if (asked?.type === "artist") {
    const artist = await findArtist(db, asked.id);
    if (artist === null) {
      throw new SubsonicError(SubsonicErrorCode.NotFound, DIRECTORY_NOT_FOUND);
    }

    const albums = await listAlbumsOfArtist(db, asked.id);

    return {
      directory: directoryElement(
        {
          id: prefixedId("artist", artist.id),
          name: artist.name,
          albumCount: artist.albumCount || undefined,
        },
        albums.map(albumChildElement),
      ),
    };
  }

  if (asked?.type === "album") {
    const album = await findAlbum(db, asked.id);
    if (album === null) {
      throw new SubsonicError(SubsonicErrorCode.NotFound, DIRECTORY_NOT_FOUND);
    }

    const tracks = await listTracksOfAlbum(db, album);

    return {
      directory: directoryElement(
        {
          id: prefixedId("album", album.id),
          name: album.name,
          parent: prefixedId("artist", album.artistId),
          coverArt: album.coverKey === null ? undefined : prefixedId("album", album.id),
          songCount: album.songCount || undefined,
        },
        tracks.map(songElement),
      ),
    };
  }

  throw new SubsonicError(SubsonicErrorCode.NotFound, DIRECTORY_NOT_FOUND);
};

/**
 * `<directory>`, Navidrome's `responses.Directory`: its attributes, then its
 * children. Callers pass the attributes already in the order that struct
 * declares them — id, name, parent, …, coverArt, songCount, albumCount — and
 * an `albumCount` or `songCount` of zero is dropped, as `omitempty` drops it.
 */
function directoryElement(
  attributes: SubsonicNode,
  children: readonly SubsonicValue[],
): SubsonicNode {
  return { ...attributes, child: omitWhenEmpty(children) };
}
