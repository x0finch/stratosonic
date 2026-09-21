/**
 * The `<artist>`, `<album>`, `<song>` and `<genre>` elements, built once here
 * for every module that answers with them: Browsing today, Lists, folder
 * browsing and Playlists next.
 *
 * Each builder mirrors the Go struct Navidrome renders the same element from
 * (server/subsonic/responses/responses.go) — the same attribute names, in the
 * same order, and present exactly when Navidrome's `omitempty` would keep
 * them. The rules that recur:
 *
 * - **Ids travel prefixed** (`ar-`/`al-`/`tr-`), as ADR-0002 says.
 * - **`isDir` is a literal `true`/`false`**, never 0 or 1: a song is not a
 *   directory and strict clients read the word.
 * - **Timestamps are ISO-8601 with milliseconds**, because clients have been
 *   seen to drop a date without a fractional part.
 * - **`coverArt` is omitted when there is no cover**, never emitted as an
 *   empty or dangling id. An album's cover-art id is its own `al-` id
 *   (CONTEXT.md), a track's is its album's, and an artist's is that of the
 *   first of its albums that has one.
 * - **`contentType` comes from the suffix map**, the same one that decides
 *   what the scan indexes.
 *
 * Escaping is not done here: the response layer escapes every attribute and
 * every element text as it renders (subsonic/response.ts).
 */

import { type Album, prefixedId, type Track } from "@stratosonic/db";
import { type SubsonicNode, TEXT_KEY } from "../subsonic/response";
import { audioContentType } from "./audio-formats";

/** An artist as the `<artist>` element needs it. */
export interface ArtistView {
  readonly id: string;
  readonly name: string;
  /** How many albums this artist is the album artist of; exact, never capped. */
  readonly albumCount: number;
  /**
   * The album whose cover stands for the artist — the first of its albums
   * that has one — or `null` when none of them do.
   */
  readonly coverAlbumId: string | null;
}

/**
 * A track together with the two things about its album a `<song>` carries:
 * the album's name, and whether it has a cover. Both come from the album row,
 * so an endpoint that already holds the album does not read it again.
 */
export interface SongView extends Track {
  readonly albumName: string | null;
  readonly albumCoverKey: string | null;
}

/** A genre and what carries it. */
export interface GenreView {
  readonly name: string;
  readonly songCount: number;
  readonly albumCount: number;
}

/**
 * An ISO-8601 instant with milliseconds, which `toISOString` always writes —
 * `2023-11-14T22:13:20.000Z`.
 */
export function subsonicTimestamp(at: Date): string {
  return at.toISOString();
}

/**
 * A child list, or nothing when it is empty. Go's `omitempty` drops an empty
 * slice, so Navidrome answers `<artists ignoredArticles="…"/>` rather than an
 * element carrying an empty list, and its JSON leaves the key out.
 */
export function omitWhenEmpty<T>(items: readonly T[]): readonly T[] | undefined {
  return items.length > 0 ? items : undefined;
}

/**
 * `<artist>`, Navidrome's `ArtistID3`: id, name, coverArt, albumCount. The
 * count is not `omitempty` there, so an artist with no albums still says 0.
 */
export function artistElement(artist: ArtistView): SubsonicNode {
  return {
    id: prefixedId("artist", artist.id),
    name: artist.name,
    coverArt: artist.coverAlbumId === null ? undefined : prefixedId("album", artist.coverAlbumId),
    albumCount: artist.albumCount,
  };
}

/**
 * `<album>`, Navidrome's `AlbumID3`. `songCount`, `duration` and `created` are
 * always emitted there; `artist`, `year` and `genre` only when they have a
 * value — and a year of 0 is no year, which is how Go's `omitempty` reads the
 * `MaxYear` Navidrome puts there. The duration is truncated to whole seconds,
 * as Navidrome's `int32(album.Duration)` does.
 */
export function albumElement(album: Album): SubsonicNode {
  return {
    id: prefixedId("album", album.id),
    name: album.name,
    artist: album.albumArtist || undefined,
    artistId: prefixedId("artist", album.artistId),
    coverArt: album.coverKey === null ? undefined : prefixedId("album", album.id),
    songCount: album.songCount,
    duration: Math.trunc(album.duration),
    created: subsonicTimestamp(album.createdAt),
    year: album.year || undefined,
    genre: album.genre || undefined,
  };
}

/**
 * `<song>`, Navidrome's `Child` as `childFromMediaFile` fills it
 * (server/subsonic/helpers.go), minus the attributes that need data
 * Stratosonic does not have yet: the annotations `starred`, `playCount` and
 * `userRating` (Phase 2) and the transcoding pair (ADR-0001, nothing is
 * transcoded).
 *
 * `path` is the track's R2 key. Navidrome sends a path too — a synthesized
 * `albumArtist/album/track - title.suffix` unless the player asks for the real
 * one — and our key is exactly that shape, so the key is both honest and what
 * a client expects to see.
 *
 * `duration` is truncated, as Navidrome truncates it, and an attribute whose
 * value is zero is left out, as `omitempty` leaves it out: a track shorter
 * than a second therefore carries no `duration`, exactly as Navidrome answers.
 */
export function songElement(song: SongView): SubsonicNode {
  return {
    id: prefixedId("track", song.id),
    parent: prefixedId("album", song.albumId),
    isDir: false,
    title: song.title,
    album: song.albumName || undefined,
    artist: song.artist || undefined,
    track: song.trackNumber || undefined,
    year: song.year || undefined,
    genre: song.genre || undefined,
    coverArt: song.albumCoverKey === null ? undefined : prefixedId("album", song.albumId),
    size: song.size || undefined,
    contentType: audioContentType(song.suffix) ?? undefined,
    suffix: song.suffix || undefined,
    duration: Math.trunc(song.duration) || undefined,
    bitRate: song.bitRate || undefined,
    path: song.r2Key || undefined,
    discNumber: song.discNumber || undefined,
    created: subsonicTimestamp(song.createdAt),
    albumId: prefixedId("album", song.albumId),
    artistId: prefixedId("artist", song.artistId),
    type: "music",
  };
}

/**
 * An album as a `<child>` of a directory, Navidrome's `childFromAlbum`
 * (server/subsonic/helpers.go). Folder browsing shows an album as a
 * sub-directory of its artist, so this is the same `Child` element a track
 * renders as — with `isDir` true — and the attributes come in the order the
 * `Child` struct declares them, which is the order Navidrome's XML carries.
 *
 * What it says that `albumElement` does not: `isDir`, a `parent` pointing at
 * the album artist, and the album's name three times over — as `title`, as
 * `name` and as `album` — because a client browsing folders reads whichever
 * of the three it was written against. Navidrome puts `FullName()` in all
 * three, which is the album's name unless an album-version suffix is
 * configured; Stratosonic stores no such suffix, so it is the name.
 *
 * `duration` and `songCount` are dropped when zero, as Go's `omitempty`
 * drops them, and `created` is always present. The annotation attributes
 * (`starred`, `playCount`, `userRating`) wait for Phase 2, as they do in
 * `songElement`.
 */
export function albumChildElement(album: Album): SubsonicNode {
  return {
    id: prefixedId("album", album.id),
    parent: prefixedId("artist", album.artistId),
    isDir: true,
    title: album.name,
    name: album.name,
    album: album.name,
    artist: album.albumArtist || undefined,
    year: album.year || undefined,
    genre: album.genre || undefined,
    coverArt: album.coverKey === null ? undefined : prefixedId("album", album.id),
    duration: Math.trunc(album.duration) || undefined,
    created: subsonicTimestamp(album.createdAt),
    artistId: prefixedId("artist", album.artistId),
    songCount: album.songCount || undefined,
  };
}

/**
 * `<genre>`, Navidrome's `Genre`: the name is the element's text rather than
 * an attribute (`xml:",chardata"`), and JSON carries it as `value`, which is
 * what the text key renders as.
 */
export function genreElement(genre: GenreView): SubsonicNode {
  return {
    [TEXT_KEY]: genre.name,
    songCount: genre.songCount,
    albumCount: genre.albumCount,
  };
}
