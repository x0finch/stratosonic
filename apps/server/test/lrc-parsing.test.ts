import { describe, expect, it } from "vitest";
import { decodeLyrics, type LyricLine, type ParsedLyrics, parseLrc } from "../src/lyrics/lrc";

/**
 * Reading a lyrics sidecar, on its own: no bucket, no database, just the text.
 *
 * The cases are Navidrome's `parseLRC` rules (model/lyrics_lrc.go), one row
 * each, and the round trip at the end is the promise that a synced lyric
 * written back as plain `[mm:ss.xx]` lines reads as the same lyric.
 */

/** A lyric with nothing but its lines, as most rows expect it. */
function lyric(lines: LyricLine[], extra: Partial<ParsedLyrics> = {}): ParsedLyrics {
  return {
    displayArtist: null,
    displayTitle: null,
    lang: "xxx",
    offset: null,
    synced: lines.some((line) => line.start !== undefined),
    lines,
    ...extra,
  };
}

describe("what a line means", () => {
  it.each<[string, string, ParsedLyrics | null]>([
    [
      "reads a timestamp as the start of its line",
      "[00:12.34]First line\n[01:02.50]Second line\n",
      lyric([
        { start: 12_340, value: "First line" },
        { start: 62_500, value: "Second line" },
      ]),
    ],
    [
      "reads one, two and three fraction digits as a fraction of a second",
      "[00:01.5]a\n[00:02.05]b\n[00:03.005]c\n[00:04]d\n",
      lyric([
        { start: 1_500, value: "a" },
        { start: 2_050, value: "b" },
        { start: 3_005, value: "c" },
        { start: 4_000, value: "d" },
      ]),
    ],
    [
      "reads an hours field in front of the minutes",
      "[01:02:03.04]late\n",
      lyric([{ start: 3_723_040, value: "late" }]),
    ],
    [
      "expands a line with several timestamps into one line each, sorted by start",
      "[00:30.00][00:10.00]Chorus\n[00:20.00]Verse\n",
      lyric([
        { start: 10_000, value: "Chorus" },
        { start: 20_000, value: "Verse" },
        { start: 30_000, value: "Chorus" },
      ]),
    ],
    [
      "keeps a timestamp after the text has begun as part of the text",
      "[00:01.00]one [00:02.00] two\n",
      lyric([{ start: 1_000, value: "one [00:02.00] two" }]),
    ],
    [
      "joins untimed text to the timed line before it",
      "[00:01.00]first\nstill first\n[00:02.00]second\n",
      lyric([
        { start: 1_000, value: "first\nstill first" },
        { start: 2_000, value: "second" },
      ]),
    ],
    [
      "drops untimed text before the first timed line",
      "a preface\n[00:01.00]first\n",
      lyric([{ start: 1_000, value: "first" }]),
    ],
    [
      "keeps a timestamp with no text as an empty line",
      "[00:01.00]sung\n[00:05.00]\n",
      lyric([
        { start: 1_000, value: "sung" },
        { start: 5_000, value: "" },
      ]),
    ],
    [
      "reads the ID tags of a synced file",
      "[ar: Tagged Artist ]\n[ti:Tagged Title]\n[lang:eng]\n[offset:+250]\n[00:01.00]x\n",
      lyric([{ start: 1_000, value: "x" }], {
        displayArtist: "Tagged Artist",
        displayTitle: "Tagged Title",
        lang: "eng",
        offset: 250,
      }),
    ],
    [
      "reads a negative offset",
      "[offset:-1500]\n[00:01.00]x\n",
      lyric([{ start: 1_000, value: "x" }], { offset: -1_500 }),
    ],
    [
      "ignores an offset that is not a whole number",
      "[offset:12ms]\n[00:01.00]x\n",
      lyric([{ start: 1_000, value: "x" }]),
    ],
    [
      "skips every other tag, [la:] included",
      "[al:Album]\n[by:someone]\n[la:en]\n[length: 03:20]\n[00:01.00]x\n",
      lyric([{ start: 1_000, value: "x" }]),
    ],
    [
      "skips background vocals",
      "[00:01.00]lead\n[bg: <00:01.50>ooh]\n[00:02.00]next\n",
      lyric([
        { start: 1_000, value: "lead" },
        { start: 2_000, value: "next" },
      ]),
    ],
    [
      "strips Enhanced LRC word timings",
      "[00:01.00]<00:01.00>Hello <00:01.50>there <00:02.00>\n",
      lyric([{ start: 1_000, value: "Hello there" }]),
    ],
    ["strips a byte-order mark", "\uFEFF[00:01.00]x\n", lyric([{ start: 1_000, value: "x" }])],
    [
      "trims lines and reads CRLF line endings",
      "  [00:01.00]  spaced  \r\n[00:02.00]windows\r\n",
      lyric([
        { start: 1_000, value: "spaced" },
        { start: 2_000, value: "windows" },
      ]),
    ],
    [
      "reads an untimed file as unsynced lines, one per non-blank line",
      "First line\n\n  Second line  \n",
      lyric([{ value: "First line" }, { value: "Second line" }]),
    ],
    [
      "reads no tags in an untimed file",
      "[ar:Someone]\nplain\n",
      lyric([{ value: "[ar:Someone]" }, { value: "plain" }]),
    ],
    ["answers no lyrics for an empty file", "", null],
    ["answers no lyrics for a file of blank lines", "\n  \n\r\n", null],
  ])("%s", (_label, text, expected) => {
    expect(parseLrc(text)).toEqual(expected);
  });

  it("answers no lyrics for tags and no timed line", () => {
    // The file is synced - a line begins with a timestamp - but that line is
    // a tag Navidrome skips, so no line of lyrics is left.
    expect(parseLrc("[00:01.00][ar:Someone]\n")).toBeNull();
  });

  it("uses the caller's language when the file names none", () => {
    expect(parseLrc("[00:01.00]x\n", "fra")?.lang).toBe("fra");
  });
});

describe("the bytes of a sidecar", () => {
  it("decodes UTF-8 and drops its byte-order mark", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("[00:01.00]é")]);

    expect(decodeLyrics(bytes)).toBe("[00:01.00]é");
  });

  it.each<[string, boolean]>([
    ["little-endian", true],
    ["big-endian", false],
  ])("decodes %s UTF-16 behind its byte-order mark", (_label, littleEndian) => {
    const text = "[00:01.00]歌词 🎵";
    const bytes = new Uint8Array(2 + text.length * 2);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0xfeff, littleEndian);
    for (let index = 0; index < text.length; index++) {
      view.setUint16(2 + index * 2, text.charCodeAt(index), littleEndian);
    }

    expect(decodeLyrics(bytes)).toBe(text);
    expect(parseLrc(decodeLyrics(bytes))?.lines).toEqual([{ start: 1_000, value: "歌词 🎵" }]);
  });
});

describe("a synced lyric written back", () => {
  /** Renders lines as plain `[mm:ss.xx]` LRC, the way a tagging tool saves them. */
  function renderLrc(lines: readonly LyricLine[]): string {
    return lines.map((line) => `${timestamp(line.start ?? 0)}${line.value}\n`).join("");
  }

  function timestamp(millis: number): string {
    const minutes = Math.floor(millis / 60_000);
    const seconds = Math.floor((millis % 60_000) / 1000);
    const hundredths = Math.floor((millis % 1000) / 10);

    return `[${pad(minutes)}:${pad(seconds)}.${pad(hundredths)}]`;
  }

  function pad(value: number): string {
    return String(value).padStart(2, "0");
  }

  it.each<[string, string]>([
    ["a plain file", "[00:01.00]one\n[00:02.50]two\n[01:00.99]three\n"],
    ["repeated timestamps", "[00:40.00][00:10.00]chorus\n[00:20.00]verse\n"],
    ["continued lines", "[00:01.00]first\nand more\n[00:02.00]second\n"],
    ["word timings", "[00:01.00]<00:01.00>word <00:01.20>by <00:01.40>word\n"],
  ])("parses %s back into the same lines", (_label, text) => {
    const parsed = parseLrc(text);

    expect(parsed).not.toBeNull();
    expect(parseLrc(renderLrc(parsed?.lines ?? []))).toEqual(parsed);
  });
});
