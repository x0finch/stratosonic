/**
 * Reading a lyrics sidecar: the text of an `.lrc` (or `.txt`) in, one
 * structured lyric or none out.
 *
 * Nothing here reads R2 or D1. It is handed the bytes or the text of one
 * sidecar and answers with what a `structuredLyrics` element needs, which is
 * the part of serving lyrics that is easiest to get subtly wrong and
 * therefore the part worth testing on its own - as `playlists/m3u.ts` is for
 * playlists.
 *
 * ## What a line means
 *
 * The rules are Navidrome's `parseLRC` (model/lyrics_lrc.go), which it runs
 * over every sidecar whatever its suffix, so a `.txt` with timestamps is as
 * synced as an `.lrc`:
 *
 * - The whole file is **synced** when any line starts with a timestamp,
 *   `[mm:ss]` with an optional `hh:` in front and a `.f` of one to three
 *   digits behind. Otherwise every non-blank line is a line of its own, with
 *   no `start`, and nothing in it is read as a tag.
 * - In a synced file, a line that carries `[ar:]`, `[ti:]`, `[lang:]` or
 *   `[offset:]` sets the display artist, display title, language or offset
 *   (milliseconds, signed). Any other `[name:value]` line - `[al:]`, `[by:]`,
 *   `[la:]`, and the `[bg:]` background vocals - is skipped whole.
 * - A line that begins with several timestamps is the same text at each of
 *   them, and the lines are then sorted by start, since nothing promises the
 *   file listed them in order.
 * - A line with no leading timestamp continues the timed line before it,
 *   joined with `\n`; before the first timed line there is nothing to
 *   continue, so it is dropped.
 * - Enhanced LRC's word timings, `<mm:ss.xx>` inside a line, are removed from
 *   the text: v1 of `songLyrics` has no place to put them.
 *
 * A file that yields no line at all is no lyrics, not an empty lyric.
 */

import { parseGoInt64 } from "../subsonic/params";

/** One line of a lyric: its text, and when it starts if the file is synced. */
export interface LyricLine {
  /** Milliseconds from the start of the track; absent when unsynced. */
  readonly start?: number;
  readonly value: string;
}

/** What one sidecar says, before anything about the track is filled in. */
export interface ParsedLyrics {
  /** The `[ar:]` tag, or null when the file does not carry one. */
  readonly displayArtist: string | null;
  /** The `[ti:]` tag, or null when the file does not carry one. */
  readonly displayTitle: string | null;
  /** The `[lang:]` tag, or the language the caller defaulted to. */
  readonly lang: string;
  /** The `[offset:]` tag in milliseconds, or null when there is none. */
  readonly offset: number | null;
  readonly synced: boolean;
  readonly lines: readonly LyricLine[];
}

/**
 * The language a lyric without a `[lang:]` tag has: ISO 639-2's "no
 * linguistic content", which is what Navidrome passes for a sidecar and what
 * the OpenSubsonic spec asks for when the language is not known.
 */
export const UNKNOWN_LANGUAGE = "xxx";

/**
 * A timestamp as `parseLRC` recognises it: `[hh:mm:ss.fff]`, where the hours
 * and the fraction are optional and every field is one or two digits (the
 * fraction one to three).
 */
const TIMESTAMP = String.raw`\[([0-9]{1,2}:)?([0-9]{1,2}):([0-9]{1,2})(\.[0-9]{1,3})?\]`;

/** Whether a file is synced: a line that begins, after blanks, with a timestamp. */
const SYNCED = new RegExp(String.raw`(^|\n)\s*${TIMESTAMP}`);

/**
 * The four tags a synced file is read for. Not anchored, as in Navidrome, so
 * a line that carries one of them anywhere is taken as that tag.
 */
const ID_TAG = /\[(ar|ti|offset|lang):([^\]]+)\]/;

/** Background vocals, which v1 has no layer for. */
const BACKGROUND_TAG = /^\[bg:(.*)\]$/;

/** Any other `[name:value]` line: a tag this server does not read. */
const UNKNOWN_TAG = /^\[[A-Za-z][^\]:]*:[^\]]*\]/;

/** Enhanced LRC's word timing, `<mm:ss.xx>`, inside a line. */
const WORD_TIMING = /<([0-9]{1,2}:)?([0-9]{1,2}):([0-9]{1,2})(\.[0-9]{1,3})?>/g;

/**
 * The text of a sidecar's bytes, as Navidrome's `ioutils.UTF8Reader` reads a
 * file: a UTF-16 byte-order mark (either order) decodes the rest as UTF-16,
 * and anything else is UTF-8 with its mark, if it has one, removed. Bytes
 * that are not valid UTF-8 become U+FFFD rather than failing the read.
 */
export function decodeLyrics(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeUtf16(bytes.subarray(2), true);
  }

  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16(bytes.subarray(2), false);
  }

  // `TextDecoder` drops a UTF-8 byte-order mark by default.
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Reads the text of a sidecar, or null when it holds no line of lyrics.
 *
 * `lang` is what the lyric is in when the file does not say: the caller's
 * default, `xxx` for a sidecar.
 */
export function parseLrc(text: string, lang: string = UNKNOWN_LANGUAGE): ParsedLyrics | null {
  const source = stripBom(text);
  const synced = SYNCED.test(source);
  const lines: LyricLine[] = [];

  let displayArtist: string | null = null;
  let displayTitle: string | null = null;
  let language = lang;
  let offset: number | null = null;

  // The timed line being read: its text so far, and the timestamps it
  // begins with. It is only written out once the next timed line (or the end
  // of the file) shows nothing more joins it.
  let prior = "";
  let starts: number[] = [];
  let open = false;
  let repeated = false;

  const flush = () => {
    const value = stripWordTimings(prior);
    for (const start of starts) {
      lines.push({ start, value });
    }
    starts = [];
  };

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();

    if (line === "") {
      if (open) {
        prior += "\n";
      }
      continue;
    }

    if (!synced) {
      lines.push({ value: line });
      continue;
    }

    const tag = ID_TAG.exec(line);
    if (tag) {
      const value = (tag[2] ?? "").trim();
      switch (tag[1]) {
        case "ar":
          displayArtist = value;
          break;
        case "ti":
          displayTitle = value;
          break;
        case "lang":
          language = value;
          break;
        case "offset": {
          // Go's `strconv.ParseInt`: a value it cannot read leaves the offset
          // unset rather than failing the file.
          const parsed = parseGoInt64(value);
          if (parsed !== null) {
            offset = Number(parsed);
          }
          break;
        }
      }
      continue;
    }

    if (BACKGROUND_TAG.test(line) || UNKNOWN_TAG.test(line)) {
      continue;
    }

    const timestamps = [...line.matchAll(new RegExp(TIMESTAMP, "g"))];
    if (timestamps.length > 1) {
      repeated = true;
    }

    const first = timestamps[0];
    if (first === undefined || first.index !== 0) {
      // Untimed text, or a timestamp after some text: it continues the timed
      // line before it, if there is one.
      if (open) {
        prior += `\n${line}`;
      }
      continue;
    }

    if (open) {
      flush();
    }

    // Every timestamp the line begins with, up to the first text between two
    // of them: `[00:10][00:20]text` is `text` twice, but a timestamp after
    // the text has begun is part of the text.
    let end = 0;
    for (const match of timestamps) {
      if (end !== 0 && line.slice(end, match.index).trim() !== "") {
        break;
      }

      end = match.index + match[0].length;
      starts.push(timestampMillis(match));
    }

    prior = line.slice(end).trim();
    open = true;
  }

  if (open) {
    flush();
  }

  if (repeated) {
    lines.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  }

  if (lines.length === 0) {
    return null;
  }

  return {
    displayArtist: nonEmpty(displayArtist),
    displayTitle: nonEmpty(displayTitle),
    lang: language,
    offset,
    synced,
    lines,
  };
}

/**
 * A timestamp's milliseconds. The fraction is a fraction of a second, so
 * `.5`, `.50` and `.500` are all half of one - Navidrome scales one digit by
 * a hundred and two by ten.
 */
function timestampMillis(match: RegExpMatchArray): number {
  const hours = match[1] === undefined ? 0 : Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2] ?? "0", 10);
  const seconds = Number.parseInt(match[3] ?? "0", 10);
  const fraction = match[4] === undefined ? "" : match[4].slice(1);
  const millis = fraction === "" ? 0 : Number.parseInt(fraction.padEnd(3, "0"), 10);

  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

/**
 * A line's text without its Enhanced LRC word timings, as Navidrome's
 * `parseEnhancedLine` builds it: the words that follow each marker, joined
 * as they stand. Text in front of the first marker belongs to no word and is
 * left out, as it is there; a line of markers and no words keeps whatever
 * text it has with the markers removed.
 */
function stripWordTimings(text: string): string {
  const markers = [...text.matchAll(WORD_TIMING)];
  if (markers.length === 0) {
    return text.trim();
  }

  let words = "";
  for (const [index, marker] of markers.entries()) {
    const from = marker.index + marker[0].length;
    const to = markers[index + 1]?.index ?? text.length;
    words += text.slice(from, to);
  }

  return words === "" ? text.replace(WORD_TIMING, "").trim() : words.trim();
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  const units: number[] = [];
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    const low = bytes[index] ?? 0;
    const high = bytes[index + 1] ?? 0;
    units.push(littleEndian ? low | (high << 8) : (low << 8) | high);
  }

  // In slices, so a large file does not overflow the argument list.
  let text = "";
  for (let index = 0; index < units.length; index += 8192) {
    text += String.fromCharCode(...units.slice(index, index + 8192));
  }

  return text;
}

function stripBom(text: string): string {
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function nonEmpty(value: string | null): string | null {
  return value === null || value === "" ? null : value;
}
