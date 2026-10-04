/**
 * Lyrics: what a client shows beside the playing track.
 *
 * They come from one of three sources, tried in Navidrome's default
 * `LyricsPriority` order, `.lrc,.txt,embedded`: the `.lrc` sidecar beside the
 * track in the bucket, then the `.txt`, both read when the client asks
 * (`lyrics/sidecar.ts`), and last the lyric the track's own tags carry, which
 * the scan stored (`lyrics/embedded.ts`) and the track lookup joins in. All
 * three go through the one LRC parser. An answer costs one track lookup and
 * at most two reads of the bucket per track it looks at, and writes nothing.
 *
 * Only the caller's libraries are looked in (#84), and a sidecar is read from
 * its track's own library (storage/track-storage.ts).
 *
 * A track without lyrics is an empty answer, never an error: every track a
 * client plays is asked about, and most have none.
 */

import { parseIdOfType } from "@stratosonic/db";
import { database } from "../db";
import { scopeOf } from "../library/scope";
import { type ParsedLyrics, parseLrc } from "../lyrics/lrc";
import { findLyricsCandidates, findLyricsTrack, type LyricsTrack } from "../lyrics/repository";
import {
  readSidecarLyrics,
  readSidecarLyricsWithSuffix,
  SIDECAR_SUFFIXES,
} from "../lyrics/sidecar";
import { joinsLibraryRow, storageOfTrack } from "../storage/track-storage";
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
 * is the empty element and nothing is looked up. Otherwise the tracks with
 * that title by that artist (`findLyricsCandidates`, those with embedded
 * lyrics first) are tried source by source - every candidate's `.lrc`, then
 * every candidate's `.txt`, then every candidate's embedded lyric - and the
 * first that yields a line answers. Its lines are sent as Navidrome's
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

  const { user } = request;
  const candidates = await findLyricsCandidates(
    database(request.env),
    artist,
    title,
    scopeOf(user),
    joinsLibraryRow(user.libraryIds),
  );

  // Each candidate's storage is built once: an S3 library's opens its
  // sealed token on first use, which should not happen once per suffix.
  const sources = candidates.map((candidate) => ({
    candidate,
    storage: storageOfTrack(request.env, candidate, candidate.library),
  }));

  // Source first, then candidate, as Navidrome's `getLyricsForCandidates`
  // nests them: an older take's `.lrc` beats the newest take's `.txt`, and
  // any sidecar beats a lyric in the tags.
  for (const suffix of SIDECAR_SUFFIXES) {
    for (const { candidate, storage } of sources) {
      const lyrics = await readSidecarLyricsWithSuffix(storage, candidate.r2Key, suffix);

      if (lyrics !== null) {
        return plainLyricsElement(artist, title, lyrics);
      }
    }
  }

  for (const candidate of candidates) {
    const lyrics = embeddedLyrics(candidate);

    if (lyrics !== null) {
      return plainLyricsElement(artist, title, lyrics);
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

  const { user } = request;
  const song = await findLyricsTrack(
    database(request.env),
    id,
    scopeOf(user),
    joinsLibraryRow(user.libraryIds),
  );
  if (song === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound, TRACK_NOT_FOUND);
  }

  const lyrics =
    (await readSidecarLyrics(storageOfTrack(request.env, song, song.library), song.r2Key)) ??
    embeddedLyrics(song);

  return {
    lyricsList:
      lyrics === null ? {} : { structuredLyrics: [structuredLyricsElement(song, lyrics)] },
  };
};

/**
 * The lyric the track's tags carry, parsed as a sidecar is, or null when the
 * scan stored none. Its language is the tag's, unless the text sets one.
 */
function embeddedLyrics(song: LyricsTrack): ParsedLyrics | null {
  return song.embedded === null ? null : parseLrc(song.embedded.text, song.embedded.lang);
}

/**
 * `<lyrics>` as Navidrome's `GetLyrics` writes it: each line's text followed
 * by a newline, the timestamps of a synced lyric left out, and the artist and
 * title the client sent rather than the track's.
 */
function plainLyricsElement(artist: string, title: string, lyrics: ParsedLyrics): SubsonicNode {
  return {
    lyrics: { artist, title, value: lyrics.lines.map((line) => `${line.value}\n`).join("") },
  };
}

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
