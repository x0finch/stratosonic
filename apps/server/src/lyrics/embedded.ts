/**
 * Finding the lyrics a track carries in its own tags, at scan time.
 *
 * Nothing here reads R2 or D1. It is handed the native tags the metadata
 * extractor read from a file's header and answers with the one lyric the
 * scan stores for the track, as text - the same text a sidecar would hold,
 * so that `lrc.ts` reads both the same way when a client asks.
 *
 * ## Which tags
 *
 * Navidrome's `lyrics` tag (resources/mappings.yaml) is `uslt:description`,
 * `lyrics` and `unsyncedlyrics`, and TagLib adds MP4's `©lyr` to it on its
 * own; its adapter also lifts ID3v2 `SYLT` frames into it. For the formats
 * this server indexes that is:
 *
 * - **ID3v2.3 / 2.4** (`mp3`): `USLT`, whose text is kept as it stands, and
 *   `SYLT`, whose timed entries are written out as LRC - `[mm:ss.xx]text`, one
 *   line each - so one parser serves both. A `SYLT` timed in MPEG frames
 *   rather than milliseconds cannot be placed without decoding the audio, so
 *   it is passed over.
 * - **Vorbis comments** (`flac`): `LYRICS` and `UNSYNCEDLYRICS`, as text.
 * - **MP4** (`m4a`): `©lyr`, as text.
 *
 * Text that is itself LRC - an `.lrc` pasted into a `USLT` or `LYRICS` tag is
 * common - is not second-guessed here: the parser decides by content at
 * request time, as it does for a `.txt` sidecar. music-metadata's own reading
 * of such text (`common.lyrics`) drops the tags and the untimed lines, which
 * is why the native tags are read instead.
 *
 * ## One lyric per track
 *
 * Navidrome keeps every lyric the tags hold and answers with all of them.
 * This server stores one per track, and it is the one `LyricList.Main()`
 * picks out of Navidrome's list: the first, synced or not, in the order the
 * file lists them. A lyric the parser finds no line in, or larger than
 * `MAX_EMBEDDED_LYRICS_BYTES`, is not a lyric and is passed over.
 */

import { parseLrc, UNKNOWN_LANGUAGE } from "./lrc";

/** The lyric the scan stores for a track. */
export interface EmbeddedLyrics {
  /** The tag's text, or a `SYLT` frame written out as LRC. */
  readonly text: string;
  /** The tag's ISO 639-2 language, lower case; `xxx` when it names none. */
  readonly lang: string;
}

/**
 * The largest lyric stored, one MiB of UTF-8: Navidrome's `maxLength` for its
 * `lyrics` tag, and the cap a sidecar is read under.
 */
export const MAX_EMBEDDED_LYRICS_BYTES = 1024 * 1024;

/** A native tag as music-metadata reports it: the frame or field id and its value. */
export interface NativeTag {
  readonly id: string;
  readonly value: unknown;
}

/** music-metadata's `native`: each tag format the file carries, and its tags. */
export type NativeTags = Readonly<Record<string, readonly NativeTag[]>>;

/** ID3v2's `SYLT` timestamp format for absolute milliseconds. */
const SYLT_MILLISECONDS = 2;

const ID3V2_TAG_TYPES = new Set(["ID3v2.3", "ID3v2.4"]);

/** Vorbis field names, which music-metadata upper-cases. */
const VORBIS_LYRICS_FIELDS = new Set(["LYRICS", "UNSYNCEDLYRICS"]);

const MP4_LYRICS_ATOM = "©lyr";

/** The lyric to store for a track with these tags, or undefined when it has none. */
export function embeddedLyricsOf(native: NativeTags): EmbeddedLyrics | undefined {
  for (const candidate of lyricsTags(native)) {
    if (candidate.text.trim() === "" || utf8Length(candidate.text) > MAX_EMBEDDED_LYRICS_BYTES) {
      continue;
    }

    if (parseLrc(candidate.text, candidate.lang) !== null) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * A `SYLT` frame's entries as LRC text: one `[mm:ss.xx]` line per entry, in
 * time order, with an hour in front once a timestamp needs one.
 */
export function syncedTextToLrc(
  entries: readonly { readonly text: string; readonly timestamp?: number }[],
): string {
  return entries
    .filter((entry) => typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp))
    .map((entry) => ({ text: entry.text, at: Math.max(0, entry.timestamp ?? 0) }))
    .sort((a, b) => a.at - b.at)
    .map((entry) => `${lrcTimestamp(entry.at)}${entry.text.trim()}\n`)
    .join("");
}

/** Every lyric the tags carry, in the order the file lists them. */
function* lyricsTags(native: NativeTags): Generator<EmbeddedLyrics> {
  for (const [tagType, tags] of Object.entries(native)) {
    for (const tag of tags) {
      const found = lyricsOfTag(tagType, tag);
      if (found !== undefined) {
        yield found;
      }
    }
  }
}

function lyricsOfTag(tagType: string, tag: NativeTag): EmbeddedLyrics | undefined {
  if (ID3V2_TAG_TYPES.has(tagType)) {
    if (tag.id === "USLT" && isRecord(tag.value) && typeof tag.value.text === "string") {
      return { text: tag.value.text, lang: language(tag.value.language) };
    }

    if (
      tag.id === "SYLT" &&
      isRecord(tag.value) &&
      tag.value.timeStampFormat === SYLT_MILLISECONDS &&
      Array.isArray(tag.value.syncText)
    ) {
      const entries = tag.value.syncText.filter(isSyncedEntry);

      return { text: syncedTextToLrc(entries), lang: language(tag.value.language) };
    }

    return undefined;
  }

  if (tagType === "vorbis" && VORBIS_LYRICS_FIELDS.has(tag.id) && typeof tag.value === "string") {
    return { text: tag.value, lang: UNKNOWN_LANGUAGE };
  }

  if (tagType === "iTunes" && tag.id === MP4_LYRICS_ATOM && typeof tag.value === "string") {
    return { text: tag.value, lang: UNKNOWN_LANGUAGE };
  }

  return undefined;
}

/**
 * An ID3v2 language code as Navidrome keys it, lower case. A frame that
 * leaves it blank, zeroed or malformed names no language, which is `xxx`.
 */
function language(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";

  return /^[a-z]{3}$/.test(code) ? code : UNKNOWN_LANGUAGE;
}

/** `[mm:ss.xx]`, or `[h:mm:ss.xx]` from an hour on - both forms `lrc.ts` reads. */
function lrcTimestamp(milliseconds: number): string {
  const hundredths = Math.floor(milliseconds / 10);
  const fraction = pad(hundredths % 100);
  const totalSeconds = Math.floor(hundredths / 100);
  const seconds = pad(totalSeconds % 60);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = pad(totalMinutes % 60);
  const hours = Math.floor(totalMinutes / 60);

  return hours === 0
    ? `[${minutes}:${seconds}.${fraction}]`
    : `[${pad(hours)}:${minutes}:${seconds}.${fraction}]`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** UTF-8 bytes, which a UTF-16 length never exceeds - so a long string skips the encode. */
function utf8Length(text: string): number {
  return text.length > MAX_EMBEDDED_LYRICS_BYTES
    ? text.length
    : new TextEncoder().encode(text).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSyncedEntry(value: unknown): value is { text: string; timestamp?: number } {
  return isRecord(value) && typeof value.text === "string";
}
