/**
 * Lyrics: what a client shows beside the playing track.
 *
 * They come from the sidecar file beside the track in the bucket, read when
 * the client asks (`lyrics/sidecar.ts`); nothing about them is stored, so an
 * answer costs one track lookup and at most two R2 reads per track it looks
 * at, and writes nothing.
 *
 * A track without lyrics is an empty answer, never an error: every track a
 * client plays is asked about, and most have none.
 */

import { parseIdOfType } from "@stratosonic/db";
import { database } from "../db";
import type { ParsedLyrics } from "../lyrics/lrc";
import { findLyricsCandidates, findLyricsTrack, type LyricsTrack } from "../lyrics/repository";
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
 * `getLyrics` when nothing matched: the element with no attributes and no
 * text, `<lyrics/>` in XML and `{"value":""}` in JSON, as Navidrome answers.
 */
const NO_LYRICS: SubsonicNode = { lyrics: { value: "" } };

/**
 * `getLyrics` (Subsonic 1.2) — the plain text of a song's lyrics, found by its
 * artist and title rather than by id, for the clients that predate
 * `getLyricsBySongId`.
 *
 * Without both an artist and a title there is nothing to match, so the answer
 * is the empty element and nothing is looked up. Otherwise the newest tracks
 * with that title by that artist (`findLyricsCandidates`) are tried in turn,
 * and the first with a sidecar answers. Its lines are sent as Navidrome's
 * `GetLyrics` writes them: each line's text followed by a newline, with the
 * timestamps of a synced file left out, and with the artist and title the
 * client sent - not the track's - on the element.
 */
export const getLyrics: SubsonicHandler = async (request) => {
  const artist = request.params.get("artist") ?? "";
  const title = request.params.get("title") ?? "";

  if (artist.trim() === "" || title.trim() === "") {
    return NO_LYRICS;
  }

  for (const candidate of await findLyricsCandidates(database(request.env), artist, title)) {
    const lyrics = await readSidecarLyrics(request.env, candidate.r2Key);

    if (lyrics !== null) {
      return {
        lyrics: { artist, title, value: lyrics.lines.map((line) => `${line.value}\n`).join("") },
      };
    }
  }

  return NO_LYRICS;
};

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
