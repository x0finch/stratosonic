/**
 * What an R2 object becomes in the library: one artist, one album, one track.
 *
 * Nothing here reads R2 or D1. It is handed an object's listing entry and what
 * the metadata extractor made of its bytes, and answers with the three rows a
 * scan writes. Keeping it pure is what lets the naming rules below be read and
 * tested on their own, because they are the part of a scan that is easiest to
 * get subtly wrong.
 *
 * ## Where a name comes from
 *
 * Navidrome takes a display album artist from the `albumartist` tag, falling
 * back to the track artist and then to `[Unknown Artist]`
 * (`model/metadata/map_participants.go`, `mapDisplayAlbumArtist` and the
 * album-artist branch of `mapParticipants`; the two constants are
 * `consts/consts.go`). A title with no tag becomes the file name without its
 * extension, and an album with no tag becomes `[Unknown Album]`.
 *
 * Stratosonic keeps all of that and inserts one step before the two
 * `[Unknown ...]` constants: the R2 key's own path. The library was uploaded
 * with rclone as `artist/album/title.ext` (#9), so a file whose tags are
 * missing still says who made it and what it belongs to, and `[Unknown ...]`
 * is left for a key that has no such segment at all - a track at the root of
 * the bucket. Landing an otherwise well-organised album under "[Unknown
 * Album]" merely because one tag is absent would be worse than reading the
 * directory it sits in, which is what the person who uploaded it meant.
 */

import {
  albumId,
  artistId,
  type NewAlbum,
  type NewArtist,
  type NewTrack,
  trackId,
} from "@stratosonic/db";
import { suffixOf } from "../library/audio-formats";
import type { TrackMetadata } from "../library/metadata";

/** Navidrome's `consts.UnknownArtist`. */
export const UNKNOWN_ARTIST = "[Unknown Artist]";

/** Navidrome's `consts.UnknownAlbum`. */
export const UNKNOWN_ALBUM = "[Unknown Album]";

/** An object in the bucket, as a listing describes it. */
export interface LibraryObject {
  readonly key: string;
  readonly size: number;
  /**
   * R2's ETag. Together with `size` it is the scan's change signal: the ETag
   * of a multipart upload is not an MD5 of the content, so neither value on
   * its own can be trusted to differ when the bytes do.
   */
  readonly etag: string;
  /** When the object was uploaded, which becomes the track's `created`. */
  readonly uploaded: Date;
}

/** The three rows one track contributes to the library. */
export interface DerivedRows {
  readonly artist: NewArtist;
  readonly album: NewAlbum;
  readonly track: NewTrack;
}

/**
 * The names a key implies on its own: `<albumArtist>/<album>/<title>.<ext>`,
 * read from the end so a bucket with a prefix above the artist still works.
 * A segment that is missing or blank is `undefined`, not an empty name.
 */
export interface PathNames {
  readonly title: string;
  readonly album: string | undefined;
  readonly albumArtist: string | undefined;
}

export function pathNames(r2Key: string): PathNames {
  const segments = r2Key.split("/");
  const fileName = segments.at(-1) ?? r2Key;

  return {
    // Navidrome's title fallback: the base name without its extension.
    title: fileName.replace(/\.[^.]+$/, ""),
    album: named(segments.at(-2)),
    albumArtist: named(segments.at(-3)),
  };
}

/**
 * The rows this object becomes.
 *
 * `createdAt` on the track is the object's upload time, so the library's
 * "newest" ordering follows when music arrived in the bucket rather than when
 * a scan happened to reach it. The album's `createdAt` starts at the same
 * instant and is corrected to the oldest of its tracks when its aggregates are
 * recomputed, which is how Navidrome folds a track's birth time into its album
 * (`model/mediafile.go`, `MediaFiles.ToAlbum`).
 *
 * The album's `songCount`, `duration` and `size` are left at zero here: they
 * are recomputed from the album's tracks once the batch is written, because a
 * single track cannot know what else the album holds.
 */
export function deriveRows(object: LibraryObject, metadata: TrackMetadata, now: Date): DerivedRows {
  const fromPath = pathNames(object.key);

  const albumArtist =
    metadata.albumArtist ?? metadata.artist ?? fromPath.albumArtist ?? UNKNOWN_ARTIST;
  const albumName = metadata.album ?? fromPath.album ?? UNKNOWN_ALBUM;
  const title = metadata.title ?? fromPath.title;
  const year = metadata.year ?? null;
  const genre = metadata.genre ?? null;

  const ofArtist = artistId(albumArtist);
  const ofAlbum = albumId(albumArtist, albumName, year);

  return {
    artist: {
      id: ofArtist,
      name: albumArtist,
      // Navidrome's `sort_artist_name`, which comes from an `albumartistsort`
      // tag and is empty when the file has none. The extractor does not read
      // sort tags, so it is always empty here - deliberately, not by
      // omission. What browsing actually sorts and buckets by is Navidrome's
      // *order* name, which `library/artist-index.ts` derives from the
      // artist's name at read time and does not need a column.
      sortName: "",
      createdAt: now,
      updatedAt: now,
    },
    album: {
      id: ofAlbum,
      name: albumName,
      artistId: ofArtist,
      albumArtist,
      year,
      genre,
      coverKey: null,
      createdAt: object.uploaded,
      updatedAt: now,
    },
    track: {
      id: trackId(object.key),
      r2Key: object.key,
      title,
      albumId: ofAlbum,
      artistId: ofArtist,
      // A track with no artist tag is credited to whoever the album is, not
      // to "[Unknown Artist]": the two would otherwise disagree about the
      // same file, and a client shows both side by side.
      artist: metadata.artist ?? albumArtist,
      albumArtist,
      trackNumber: metadata.trackNumber ?? null,
      discNumber: metadata.discNumber ?? null,
      year,
      duration: metadata.duration,
      bitRate: metadata.bitRate,
      size: object.size,
      suffix: suffixOf(object.key),
      genre,
      etag: object.etag,
      createdAt: object.uploaded,
      updatedAt: now,
    },
  };
}

/** A path segment only names something when it is there and not blank. */
function named(segment: string | undefined): string | undefined {
  const trimmed = segment?.trim();

  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
