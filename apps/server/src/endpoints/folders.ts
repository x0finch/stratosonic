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
import { type Database, database } from "../db";
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
  albumChildElement,
  directoryAnnotationAttributes,
  indexArtistElement,
  omitWhenEmpty,
  songElement,
} from "../library/serializers";
import { lastScanStartedAt } from "../scanner/state";
import { parseGoInt64, requiredParameter } from "../subsonic/params";
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
 * **falls back to `time.Now()` when nothing has recorded one yet**
 * (`getArtist` in server/subsonic/browsing.go). The Scan records exactly that
 * (`scanner/state.ts`), so this reads it and the fallback is left for a
 * server that has never scanned — which is also the safe answer there, since
 * a library that says it changed just now is never skipped by a client's
 * conditional request, and a client doing its first sync needs the data.
 *
 * The start, not the finish: a pass in flight is still writing rows, and a
 * client that cached against its *finish* would never come back for them.
 */
async function libraryLastModified(db: Database): Promise<number> {
  return (await lastScanStartedAt(db))?.getTime() ?? Date.now();
}

/** 1970-01-02, the earliest instant Navidrome accepts as a real timestamp. */
const EARLIEST_MODIFIED_SINCE = 86_400_000n;

/**
 * `ifModifiedSince` as Navidrome reads it (`req.Values.TimeOr`): epoch
 * milliseconds, where an absent value, `-1`, anything `strconv.ParseInt`
 * cannot read, and any instant before 1970-01-02 all mean "no condition" —
 * the zero time, which every library modification is after.
 *
 * The answer is a `bigint` so that an instant past 2^53 milliseconds stays
 * exactly where the client put it, in the far future, rather than rounding
 * to something the library might appear to be newer than. JavaScript compares
 * a number against a bigint exactly, so the caller can hold a plain
 * `lastModified`.
 */
function ifModifiedSince(params: URLSearchParams): bigint {
  const value = params.get("ifModifiedSince");
  if (value === null || value === "" || value === "-1") {
    return 0n;
  }

  const since = parseGoInt64(value);

  return since !== null && since >= EARLIEST_MODIFIED_SINCE ? since : 0n;
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

  const db = database(request.env);
  const lastModified = await libraryLastModified(db);
  const unchanged = lastModified <= ifModifiedSince(request.params);
  const artists = unchanged ? [] : await listArtists(db, request.user.id);

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
    const artist = await findArtist(db, asked.id, request.user.id);
    if (artist === null) {
      throw new SubsonicError(SubsonicErrorCode.NotFound, DIRECTORY_NOT_FOUND);
    }

    const albums = await listAlbumsOfArtist(db, asked.id, request.user.id);

    return {
      directory: directoryElement(
        {
          id: prefixedId("artist", artist.id),
          name: artist.name,
          ...directoryAnnotationAttributes(artist),
          albumCount: artist.albumCount || undefined,
        },
        albums.map(albumChildElement),
      ),
    };
  }

  if (asked?.type === "album") {
    const album = await findAlbum(db, asked.id, request.user.id);
    if (album === null) {
      throw new SubsonicError(SubsonicErrorCode.NotFound, DIRECTORY_NOT_FOUND);
    }

    const tracks = await listTracksOfAlbum(db, album, request.user.id);

    return {
      directory: directoryElement(
        {
          id: prefixedId("album", album.id),
          name: album.name,
          parent: prefixedId("artist", album.artistId),
          ...directoryAnnotationAttributes(album),
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
 * declares them — id, name, parent, the caller's annotation (starred,
 * playCount, played, userRating), coverArt, songCount, albumCount — and an
 * `albumCount` or `songCount` of zero is dropped, as `omitempty` drops it.
 *
 * The directory itself is annotated, not only its children: Navidrome's
 * directory builders fill those four from the artist's or the album's own
 * annotation, so a client browsing folders sees a starred album as starred
 * whether it is looking at it or at its parent.
 */
function directoryElement(
  attributes: SubsonicNode,
  children: readonly SubsonicValue[],
): SubsonicNode {
  return { ...attributes, child: omitWhenEmpty(children) };
}
