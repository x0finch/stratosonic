import { describe, expect, it } from "vitest";
import { bytesSource } from "../src/library/byte-source";
import { extractMetadata } from "../src/library/metadata";
import {
  embeddedLyricsOf,
  MAX_EMBEDDED_LYRICS_BYTES,
  type NativeTags,
  syncedTextToLrc,
} from "../src/lyrics/embedded";
import { parseLrc } from "../src/lyrics/lrc";
import { fixtureBytes, fixtures } from "./fixtures/files";

/**
 * The lyric a track's tags carry, as the scan reads it: from each fixture's
 * own bytes, and from the native tags music-metadata hands over.
 *
 * What each fixture carries - the tag, the text the scan stores, its language
 * and what the parser makes of it - is in `manifest.json`; nothing is restated.
 */

describe.each(fixtures.lyricsTracks.map((track) => [track.file, track] as const))(
  "reading %s",
  (_file, track) => {
    it("finds the lyric its tags carry, as the text the scan stores", async () => {
      const metadata = await extractMetadata(bytesSource(fixtureBytes(track.file)), track.suffix);

      expect(metadata.lyrics).toEqual({ text: track.lyrics.storedText, lang: track.lyrics.lang });
      expect(metadata.title).toBe(track.tags?.title);
    });

    it("stores text the LRC parser reads as the manifest says", () => {
      const parsed = parseLrc(track.lyrics.storedText, track.lyrics.lang);

      expect(parsed?.synced).toBe(track.lyrics.synced);
      expect(parsed?.lang).toBe(track.lyrics.lang);
      expect(parsed?.displayArtist).toBe(track.lyrics.displayArtist);
      expect(parsed?.lines).toEqual(track.lyrics.lines);
    });
  },
);

describe("the fixtures without lyrics", () => {
  it.each(fixtures.tracks.map((track) => [track.file, track] as const))(
    "find none in %s",
    async (_file, track) => {
      const metadata = await extractMetadata(bytesSource(fixtureBytes(track.file)), track.suffix);

      expect(metadata.lyrics).toBeUndefined();
    },
  );
});

/** An ID3v2 `USLT` as music-metadata reports it. */
function uslt(text: string, language = "eng", tagType = "ID3v2.3"): NativeTags {
  return { [tagType]: [{ id: "USLT", value: { language, descriptor: "", text } }] };
}

/** An ID3v2 `SYLT` as music-metadata reports it. */
function sylt(
  syncText: { text: string; timestamp: number }[],
  timeStampFormat = 2,
  language = "eng",
): NativeTags {
  return {
    "ID3v2.4": [
      {
        id: "SYLT",
        value: { language, descriptor: "", contentType: 1, timeStampFormat, syncText },
      },
    ],
  };
}

describe("choosing the lyric to store", () => {
  it("keeps a USLT's text as it stands, LRC or not", () => {
    const lrc = "[ar:Someone]\n[00:01.00]timed\nuntimed continuation\n";

    expect(embeddedLyricsOf(uslt(lrc))).toEqual({ text: lrc, lang: "eng" });
  });

  it("writes a SYLT out as LRC, in time order", () => {
    const lyrics = embeddedLyricsOf(
      sylt([
        { text: "second", timestamp: 2_345 },
        { text: " first ", timestamp: 1_000 },
      ]),
    );

    expect(lyrics).toEqual({ text: "[00:01.00]first\n[00:02.34]second\n", lang: "eng" });
  });

  it("writes an hour in front of a timestamp that needs one", () => {
    expect(syncedTextToLrc([{ text: "late", timestamp: 3_723_450 }])).toBe("[01:02:03.45]late\n");
    expect(parseLrc(syncedTextToLrc([{ text: "late", timestamp: 3_723_450 }]))?.lines).toEqual([
      { start: 3_723_450, value: "late" },
    ]);
  });

  it("passes over a SYLT timed in MPEG frames", () => {
    expect(embeddedLyricsOf(sylt([{ text: "frame", timestamp: 40 }], 1))).toBeUndefined();
  });

  it("takes the first lyric the file lists, synced or not, as Navidrome's Main() does", () => {
    const native: NativeTags = {
      "ID3v2.3": [
        { id: "USLT", value: { language: "eng", descriptor: "", text: "plain" } },
        {
          id: "SYLT",
          value: {
            language: "fra",
            descriptor: "",
            contentType: 1,
            timeStampFormat: 2,
            syncText: [{ text: "timed", timestamp: 500 }],
          },
        },
      ],
    };

    expect(embeddedLyricsOf(native)).toEqual({ text: "plain", lang: "eng" });
  });

  it("passes over a first lyric with no line in it for the next", () => {
    const native: NativeTags = {
      "ID3v2.3": [
        { id: "USLT", value: { language: "eng", descriptor: "", text: "\n\n" } },
        { id: "USLT", value: { language: "deu", descriptor: "", text: "words" } },
      ],
    };

    expect(embeddedLyricsOf(native)).toEqual({ text: "words", lang: "deu" });
  });

  it("reads ID3v2.2's ULT and SLT as USLT and SYLT", () => {
    expect(embeddedLyricsOf(uslt("older words", "ita", "ID3v2.2"))).toBeUndefined();
    expect(
      embeddedLyricsOf({
        "ID3v2.2": [{ id: "ULT", value: { language: "ita", descriptor: "", text: "older" } }],
      }),
    ).toEqual({ text: "older", lang: "ita" });
    expect(
      embeddedLyricsOf({
        "ID3v2.2": [
          {
            id: "SLT",
            value: {
              language: "ita",
              descriptor: "",
              contentType: 1,
              timeStampFormat: 2,
              syncText: [{ text: "timed", timestamp: 1_000 }],
            },
          },
        ],
      }),
    ).toEqual({ text: "[00:01.00]timed\n", lang: "ita" });
  });

  it("passes over an SLT that music-metadata left undecoded", () => {
    expect(embeddedLyricsOf({ "ID3v2.2": [{ id: "SLT", value: [] }] })).toBeUndefined();
  });

  it("takes the first of several unsynced lyrics", () => {
    const native: NativeTags = {
      vorbis: [
        { id: "UNSYNCEDLYRICS", value: "first" },
        { id: "LYRICS", value: "second" },
      ],
    };

    expect(embeddedLyricsOf(native)).toEqual({ text: "first", lang: "xxx" });
  });

  it("reads MP4's ©lyr and a Vorbis LYRICS as text in no stated language", () => {
    expect(embeddedLyricsOf({ iTunes: [{ id: "©lyr", value: "atom" }] })).toEqual({
      text: "atom",
      lang: "xxx",
    });
    expect(embeddedLyricsOf({ vorbis: [{ id: "LYRICS", value: "comment" }] })).toEqual({
      text: "comment",
      lang: "xxx",
    });
  });

  it.each([
    ["upper case", "ENG", "eng"],
    ["zeroed", "\u0000\u0000\u0000", "xxx"],
    ["blank", "   ", "xxx"],
    ["not a code", "e1g", "xxx"],
  ])("reads a %s language as %s", (_label, language, expected) => {
    expect(embeddedLyricsOf(uslt("words", language))?.lang).toBe(expected);
  });

  it("stores nothing for a blank lyric, or one of blank lines", () => {
    expect(embeddedLyricsOf(uslt(""))).toBeUndefined();
    expect(embeddedLyricsOf(uslt("\n  \n"))).toBeUndefined();
  });

  it("stores nothing for a lyric larger than a mebibyte", () => {
    expect(embeddedLyricsOf(uslt("x".repeat(MAX_EMBEDDED_LYRICS_BYTES + 1)))).toBeUndefined();
    // Counted in UTF-8: half as many two-byte characters are just as large.
    expect(embeddedLyricsOf(uslt("é".repeat(MAX_EMBEDDED_LYRICS_BYTES / 2 + 1)))).toBeUndefined();
    expect(embeddedLyricsOf(uslt("x".repeat(MAX_EMBEDDED_LYRICS_BYTES)))?.text).toHaveLength(
      MAX_EMBEDDED_LYRICS_BYTES,
    );
  });

  it("ignores tags that are not lyrics, and lyrics tags of other formats", () => {
    const native: NativeTags = {
      "ID3v2.3": [{ id: "COMM", value: { language: "eng", descriptor: "", text: "a comment" } }],
      vorbis: [{ id: "COMMENT", value: "a comment" }],
      APEv2: [{ id: "Lyrics", value: "not a format this server indexes" }],
    };

    expect(embeddedLyricsOf(native)).toBeUndefined();
  });
});
