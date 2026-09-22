/**
 * Lyrics: what a client shows beside the playing track.
 *
 * They come from the sidecar file beside the track in the bucket, read when
 * the client asks (`lyrics/sidecar.ts`); nothing about them is stored, so an
 * answer costs one track lookup and at most two R2 reads, and writes nothing.
 *
 * A track without lyrics is an empty answer, never an error: every track a
 * client plays is asked about, and most have none.
 */

import { parseIdOfType } from "@stratosonic/db";
import { database } from "../db";
import type { ParsedLyrics } from "../lyrics/lrc";
import { findLyricsTrack, type LyricsTrack } from "../lyrics/repository";
import { readSidecarLyrics } from "../lyrics/sidecar";
import { requiredParameter } from "../subsonic/params";
import { SubsonicError, SubsonicErrorCode, type SubsonicNode } from "../subsonic/response";
import type { SubsonicHandler } from "../subsonic/router";

/**
 * Navidrome's answer for an id that names no track: its `MediaFile.Get`
 * returns `ErrNotFound`, which `mapToSubsonicError` words this way.
 */
const TRACK_NOT_FOUND = "data not found";

/**
 * `getLyricsBySongId` (OpenSubsonic `songLyrics`, version 1) — the lyrics of
 * one track, as a `lyricsList` of zero or one `structuredLyrics`.
 *
 * `enhanced` is not read: it asks for version 2's word timings and lyric
 * kinds, and without it Navidrome answers with this same shape, which is all
 * version 1 promises.
 */
export const getLyricsBySongId: SubsonicHandler = async (request) => {
  const id = parseIdOfType("track", requiredParameter(request.params, "id"));
  if (id === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound, TRACK_NOT_FOUND);
  }

  const song = await findLyricsTrack(database(request.env), id);
  if (song === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound, TRACK_NOT_FOUND);
  }

  const lyrics = await readSidecarLyrics(request.env, song.r2Key);

  return {
    lyricsList:
      lyrics === null ? {} : { structuredLyrics: [structuredLyricsElement(song, lyrics)] },
  };
};

/**
 * `<structuredLyrics>`, in Navidrome's field order (`responses.StructuredLyric`):
 * the display artist and title - the file's own tags, else the track's -
 * the language, the lines, the offset only when the file set one, and
 * whether it is synced. A line carries `start` only when the file is synced.
 */
function structuredLyricsElement(song: LyricsTrack, lyrics: ParsedLyrics): SubsonicNode {
  return {
    displayArtist: omitWhenBlank(lyrics.displayArtist ?? song.artist),
    displayTitle: omitWhenBlank(lyrics.displayTitle ?? song.title),
    lang: lyrics.lang,
    line: lyrics.lines.map((line) => ({ start: line.start, value: line.value })),
    offset: lyrics.offset ?? undefined,
    synced: lyrics.synced,
  };
}

/** Navidrome tags both display fields `omitempty`. */
function omitWhenBlank(value: string): string | undefined {
  return value === "" ? undefined : value;
}
