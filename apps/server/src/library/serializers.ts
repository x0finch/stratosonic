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

/**
 * What the caller has done to an item, joined into a read (library/
 * annotations.ts) and rendered onto the element here.
 *
 * `starred` is the flag, `starredAt` the instant it was set (rendered as the
 * `starred` attribute); `rating`, `playCount` and `playDate` are 0 / 0 / null
 * when the caller has never rated or played the item, in which case each
 * attribute is omitted — exactly the Phase 1 output.
 */
export interface CallerAnnotation {
  readonly starred: boolean;
  readonly starredAt: Date | null;
  readonly rating: number;
  readonly playCount: number;
  readonly playDate: Date | null;
}

/**
 * The item's own row carries no annotation, so it rides alongside as an
 * optional field; absent or `null`, the element renders as it did in Phase 1.
 */
export interface Annotated {
  readonly annotation?: CallerAnnotation | null;
}

/** An artist as the `<artist>` element needs it. */
export interface ArtistView extends Annotated {
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

/** An album row with the caller's annotation, for the two `<album>` elements. */
export type AlbumView = Album & Annotated;

/**
 * A track together with the two things about its album a `<song>` carries:
 * the album's name, and whether it has a cover. Both come from the album row,
 * so an endpoint that already holds the album does not read it again — plus
 * the caller's annotation, joined in the same statement.
 */
export interface SongView extends Track, Annotated {
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
 * The `starred` attribute: the instant the caller starred the item, or nothing
 * when they have not. Navidrome renders `starred` as the timestamp, present
 * only while the item is starred (`*time.Time` with `omitempty`).
 */
function starredAttribute(item: Annotated): string | undefined {
  const { annotation } = item;

  return annotation?.starred && annotation.starredAt
    ? subsonicTimestamp(annotation.starredAt)
    : undefined;
}

/** The `userRating`, 1–5, or nothing when the caller has not rated the item. */
function userRatingAttribute(item: Annotated): number | undefined {
  return item.annotation && item.annotation.rating > 0 ? item.annotation.rating : undefined;
}

/** The `playCount`, or nothing when the caller has never played the item. */
function playCountAttribute(item: Annotated): number | undefined {
  return item.annotation && item.annotation.playCount > 0 ? item.annotation.playCount : undefined;
}

/** The `played` instant — the caller's last play — or nothing when there is none. */
function playedAttribute(item: Annotated): string | undefined {
  return item.annotation?.playDate ? subsonicTimestamp(item.annotation.playDate) : undefined;
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
    starred: starredAttribute(artist),
    userRating: userRatingAttribute(artist),
  };
}

/**
 * `<artist>` as the *folder* side of the protocol spells it, Navidrome's
 * `responses.Artist` filled by `toArtist` (server/subsonic/helpers.go): id,
 * name and the cover the artist borrows from its albums — and **no
 * `albumCount`**, which only `ArtistID3` carries. `getIndexes` answers with
 * these, and so does anything else that lists artists outside the ID3
 * endpoints.
 *
 * `artistImageUrl` is left out: Navidrome fills it with an absolute URL to an
 * image endpoint Stratosonic does not serve. A client falls back to
 * `coverArt`, which is the trap #9 names — artist images only via
 * `<artist coverArt>`.
 */
export function indexArtistElement(artist: ArtistView): SubsonicNode {
  return {
    id: prefixedId("artist", artist.id),
    name: artist.name,
    coverArt: artist.coverAlbumId === null ? undefined : prefixedId("album", artist.coverAlbumId),
    starred: starredAttribute(artist),
    userRating: userRatingAttribute(artist),
  };
}

/**
 * `<album>`, Navidrome's `AlbumID3`. `songCount`, `duration` and `created` are
 * always emitted there; `artist`, `year` and `genre` only when they have a
 * value — and a year of 0 is no year, which is how Go's `omitempty` reads the
 * `MaxYear` Navidrome puts there. The duration is truncated to whole seconds,
 * as Navidrome's `int32(album.Duration)` does.
 */
export function albumElement(album: AlbumView): SubsonicNode {
  return {
    id: prefixedId("album", album.id),
    name: album.name,
    artist: album.albumArtist || undefined,
    artistId: prefixedId("artist", album.artistId),
    coverArt: album.coverKey === null ? undefined : prefixedId("album", album.id),
    songCount: album.songCount,
    duration: Math.trunc(album.duration),
    playCount: playCountAttribute(album),
    created: subsonicTimestamp(album.createdAt),
    starred: starredAttribute(album),
    year: album.year || undefined,
    genre: album.genre || undefined,
    played: playedAttribute(album),
    userRating: userRatingAttribute(album),
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
    starred: starredAttribute(song),
    duration: Math.trunc(song.duration) || undefined,
    bitRate: song.bitRate || undefined,
    path: song.r2Key || undefined,
    playCount: playCountAttribute(song),
    played: playedAttribute(song),
    discNumber: song.discNumber || undefined,
    created: subsonicTimestamp(song.createdAt),
    albumId: prefixedId("album", song.albumId),
    artistId: prefixedId("artist", song.artistId),
    type: "music",
    userRating: userRatingAttribute(song),
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
 * drops them, and `created` is always present. `year` is the album's one
 * year: Navidrome sends `cmp.Or(MaxOriginalYear, MaxYear)` because it tracks
 * an original and a release year per album, and Stratosonic stores a single
 * `year`, which is what both of those collapse to here. The annotation attributes
 * (`starred`, `playCount`, `userRating`) wait for Phase 2, as they do in
 * `songElement`.
 */
export function albumChildElement(album: AlbumView): SubsonicNode {
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
    starred: starredAttribute(album),
    duration: Math.trunc(album.duration) || undefined,
    playCount: playCountAttribute(album),
    played: playedAttribute(album),
    created: subsonicTimestamp(album.createdAt),
    artistId: prefixedId("artist", album.artistId),
    songCount: album.songCount || undefined,
    userRating: userRatingAttribute(album),
  };
}

/**
 * `<playlist>`, Navidrome's `Playlist` (server/subsonic/responses/
 * responses.go), filled by its `buildPlaylist`: id, name, comment, songCount,
 * duration, public, owner, created, changed, coverArt — in that order, which
 * is the order its XML carries.
 *
 * `comment` and `owner` are `omitempty` there and are dropped when empty
 * here; `public` is not, so it is always written, even as `false`. The
 * duration is truncated to whole seconds, as Navidrome's `int32(p.Duration)`
 * truncates it.
 *
 * The OpenSubsonic `readonly`/`validUntil` pair Navidrome adds is left out:
 * both describe whether a client may edit the playlist through the write
 * endpoints, which Phase 1 does not serve at all.
 *
 * `coverArt` is the id of the album that lends the playlist its artwork, so
 * it resolves through the same `getCoverArt` an album's does. Navidrome sends
 * a `pl-` id there and paints a mosaic of the playlist's albums behind it;
 * with no image pipeline, borrowing one album's cover is the closest thing
 * that is not a dangling id, and a playlist whose entries have no artwork
 * says nothing at all.
 */
export function playlistElement(playlist: PlaylistView): SubsonicNode {
  return {
    id: prefixedId("playlist", playlist.id),
    name: playlist.name,
    comment: playlist.comment || undefined,
    songCount: playlist.songCount,
    duration: Math.trunc(playlist.duration),
    public: playlist.public,
    owner: playlist.ownerName || undefined,
    created: subsonicTimestamp(playlist.createdAt),
    changed: subsonicTimestamp(playlist.changedAt),
    coverArt:
      playlist.coverAlbumId === null ? undefined : prefixedId("album", playlist.coverAlbumId),
  };
}

/** What a `<playlist>` needs; the playlist reads answer with exactly this. */
export interface PlaylistView {
  readonly id: string;
  readonly name: string;
  readonly comment: string;
  readonly public: boolean;
  readonly songCount: number;
  readonly duration: number;
  readonly createdAt: Date;
  readonly changedAt: Date;
  /** The name of the user who owns it. */
  readonly ownerName: string;
  /** The album whose cover stands for it, or null when it has none. */
  readonly coverAlbumId: string | null;
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
