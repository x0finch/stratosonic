import { describe, expect, it } from "vitest";
import {
  ALLOWED,
  checkBrowsePrefix,
  checkFolderPrefix,
  checkUploadKey,
  checkUploadSize,
  contentTypeOf,
  hasOneSpelling,
  isAscii,
  kindOf,
  MAX_KEY_BYTES,
  MAX_SEGMENT_BYTES,
  oneSpellingPrefix,
} from "../src/files/keys";
import { AUDIO_CONTENT_TYPES, AUDIO_SUFFIXES } from "../src/library/audio-formats";
import { MAX_SIDECAR_BYTES, SIDECAR_SUFFIXES } from "../src/lyrics/sidecar";
import { PLAYLIST_SUFFIXES } from "../src/playlists/m3u";
import { COVER_PREFIX, IMAGE_SUFFIXES } from "../src/scanner/covers";

/**
 * The key rules of the Files page (#83, "Keys and the allow-list";
 * files/keys.ts): what a new key may be, what each suffix is, and which
 * prefixes browse and delete-folder take.
 */

describe("a new upload key", () => {
  it("is normalised to NFC", () => {
    const nfd = "Björk/Homogenic/01 Hunter.flac";
    const result = checkUploadKey(nfd);

    expect(result).toMatchObject({ key: "Björk/Homogenic/01 Hunter.flac", kind: "audio" });
    expect("key" in result && result.key).not.toBe(nfd);
  });

  it("keeps an acceptable key as it is", () => {
    expect(checkUploadKey("Artist/Album (2001) [FLAC]/01 It's #1 & 100% + more.flac")).toEqual({
      key: "Artist/Album (2001) [FLAC]/01 It's #1 & 100% + more.flac",
      kind: "audio",
      suffix: "flac",
      contentType: "audio/flac",
    });
  });

  it.each([
    ["an empty name", ""],
    ["a `..` segment", "Artist/../Album/01.flac"],
    ["a leading `..`", "../01.flac"],
    ["a `.` segment", "Artist/./01.flac"],
    ["an empty segment", "a//b.flac"],
    ["a leading slash", "/Artist/01.flac"],
    ["a trailing slash", "Artist/Album/"],
    ["a trailing slash after a file name", "Artist/01.flac/"],
    ["a NUL", "Artist/01\u0000.flac"],
    ["a newline", "Artist/01\n.flac"],
    ["a DEL", "Artist/01\u007f.flac"],
    ["a backslash", "Artist\\Album\\01.flac"],
    ["a hidden file", "Artist/.DS_Store"],
    ["an AppleDouble file", "Artist/._01.flac"],
    ["a hidden folder", "Artist/.hidden/01.flac"],
    ["a lone high surrogate", "Artist/01 \ud800.flac"],
    ["a lone low surrogate", "Artist/\udc00/01.flac"],
  ])("refuses %s as invalid_path", (_, key) => {
    expect(checkUploadKey(key)).toEqual({ error: "invalid_path" });
  });

  it.each([
    ["the cover prefix itself", `${COVER_PREFIX}abc.jpg`],
    ["a folder under it", `${COVER_PREFIX}sub/cover.png`],
  ])("refuses %s as reserved_path", (_, key) => {
    expect(checkUploadKey(key)).toEqual({ error: "reserved_path" });
  });

  it("counts the key's 1,024 bytes in UTF-8", () => {
    // 400 three-byte characters is 1,200 bytes but 400 UTF-16 units. Split
    // into segments that each fit, so only the key's own limit is met.
    const segment = "一".repeat(80);
    const key = `${Array.from({ length: 5 }, () => segment).join("/")}.flac`;
    expect(key.length).toBeLessThan(MAX_KEY_BYTES);
    expect(checkUploadKey(key)).toEqual({ error: "path_too_long" });

    const fits = `${"a/".repeat(509)}xy.mp3`;
    expect(new TextEncoder().encode(fits).length).toBe(MAX_KEY_BYTES);
    expect(checkUploadKey(fits)).toMatchObject({ kind: "audio" });
    expect(checkUploadKey(`a${fits}`)).toEqual({ error: "path_too_long" });
  });

  it("refuses a segment over 255 bytes of UTF-8", () => {
    // 84 three-byte characters and `.flac` is 257 bytes, 89 UTF-16 units.
    expect(checkUploadKey(`Artist/${"一".repeat(84)}.flac`)).toEqual({
      error: "path_too_long",
    });
    const fits = `${"x".repeat(MAX_SEGMENT_BYTES - ".flac".length)}.flac`;
    expect(checkUploadKey(`Artist/${fits}`)).toMatchObject({ kind: "audio" });
  });

  it.each([
    ["a PDF", "Artist/notes.pdf"],
    ["a video", "Artist/clip.mp4"],
    ["a cue sheet", "Artist/Album.cue"],
    ["no suffix", "Artist/README"],
  ])("refuses %s as type_not_allowed", (_, key) => {
    expect(checkUploadKey(key)).toEqual({ error: "type_not_allowed" });
  });

  it("reads suffixes ignoring case", () => {
    expect(checkUploadKey("Artist/01.FLAC")).toMatchObject({
      key: "Artist/01.FLAC",
      kind: "audio",
      suffix: "flac",
      contentType: "audio/flac",
    });
    expect(checkUploadKey("Artist/Cover.JPEG")).toMatchObject({ kind: "image" });
    expect(kindOf("Artist/01.Mp3")).toBe("audio");
  });
});

describe("the allow-list", () => {
  it("equals the union of the scanner's own constants, kind by kind", () => {
    expect(ALLOWED.audio.suffixes).toEqual(AUDIO_SUFFIXES);
    expect(ALLOWED.lyrics.suffixes).toEqual(SIDECAR_SUFFIXES.map((suffix) => suffix.slice(1)));
    expect(ALLOWED.playlist.suffixes).toEqual(PLAYLIST_SUFFIXES);
    expect([...ALLOWED.image.suffixes].sort()).toEqual([...IMAGE_SUFFIXES, "jpeg"].sort());

    const union = new Set([
      ...AUDIO_SUFFIXES,
      ...SIDECAR_SUFFIXES.map((suffix) => suffix.slice(1)),
      ...PLAYLIST_SUFFIXES,
      ...IMAGE_SUFFIXES,
      "jpeg",
    ]);
    const listed = Object.values(ALLOWED).flatMap((rule) => rule.suffixes);
    expect(new Set(listed)).toEqual(union);
    expect(listed).toHaveLength(union.size);
  });

  it("is the spec's table today", () => {
    expect(ALLOWED).toEqual({
      audio: { suffixes: ["mp3", "m4a", "flac"], maxBytes: 5_363_466_240 },
      lyrics: { suffixes: ["lrc", "txt"], maxBytes: MAX_SIDECAR_BYTES },
      playlist: { suffixes: ["m3u", "m3u8"], maxBytes: 4_194_304 },
      image: { suffixes: ["jpg", "png", "gif", "webp", "jpeg"], maxBytes: 20_971_520 },
    });
  });

  it("gives each suffix its content type", () => {
    for (const suffix of AUDIO_SUFFIXES) {
      expect(contentTypeOf("audio", suffix)).toBe(AUDIO_CONTENT_TYPES[suffix]);
    }
    expect(contentTypeOf("lyrics", "lrc")).toBe("text/plain");
    expect(contentTypeOf("lyrics", "txt")).toBe("text/plain");
    expect(contentTypeOf("playlist", "m3u")).toBe("audio/x-mpegurl");
    expect(contentTypeOf("playlist", "m3u8")).toBe("application/vnd.apple.mpegurl");
    expect(contentTypeOf("image", "jpg")).toBe("image/jpeg");
    expect(contentTypeOf("image", "jpeg")).toBe("image/jpeg");
    expect(contentTypeOf("image", "png")).toBe("image/png");
    expect(contentTypeOf("image", "gif")).toBe("image/gif");
    expect(contentTypeOf("image", "webp")).toBe("image/webp");
  });

  it("names everything else other", () => {
    expect(kindOf("Artist/Album.cue")).toBe("other");
    expect(kindOf("Artist/rip.log")).toBe("other");
    expect(kindOf("Artist/README")).toBe("other");
    expect(kindOf("Artist/01.lrc")).toBe("lyrics");
    expect(kindOf("playlists/mix.m3u8")).toBe("playlist");
  });

  it("refuses an empty file, and one over its kind's size", () => {
    expect(checkUploadSize("audio", 0)).toBe("empty_file");
    expect(checkUploadSize("lyrics", MAX_SIDECAR_BYTES)).toBeNull();
    expect(checkUploadSize("lyrics", MAX_SIDECAR_BYTES + 1)).toBe("too_large");
    expect(checkUploadSize("audio", 5_363_466_240)).toBeNull();
    expect(checkUploadSize("audio", 5_363_466_241)).toBe("too_large");
  });
});

describe("a folder's prefix", () => {
  it("is the root or ends in a slash, for browse", () => {
    expect(checkBrowsePrefix("")).toBeNull();
    expect(checkBrowsePrefix("Artist/")).toBeNull();
    expect(checkBrowsePrefix("Artist/Album/")).toBeNull();
    expect(checkBrowsePrefix("Artist")).toBe("invalid_path");
    expect(checkBrowsePrefix(`${"a".repeat(MAX_KEY_BYTES)}/`)).toBe("invalid_path");
    expect(checkBrowsePrefix(COVER_PREFIX)).toBe("reserved_path");
    expect(checkBrowsePrefix(`${COVER_PREFIX}sub/`)).toBe("reserved_path");
  });

  it("is never the root, for delete-folder", () => {
    expect(checkFolderPrefix("")).toBe("invalid_path");
    expect(checkFolderPrefix("Artist")).toBe("invalid_path");
    expect(checkFolderPrefix("Artist/")).toBeNull();
    expect(checkFolderPrefix(COVER_PREFIX)).toBe("reserved_path");
  });

  it("is taken as given, not normalised", () => {
    // A NFD prefix from a listing is a valid prefix as it stands.
    expect(checkBrowsePrefix("Björk/")).toBeNull();
  });
});

describe("a segment's spellings", () => {
  it("are three ASCII characters' own besides: K, ; and ` are another code point's NFC", () => {
    // Every code point whose NFC is a single ASCII character other than
    // itself: the ASCII a stored key may spell another way.
    const targets = new Set<string>();
    for (let code = 0x80; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) {
        continue;
      }
      const nfc = String.fromCodePoint(code).normalize("NFC");
      if (nfc.length === 1 && nfc.charCodeAt(0) < 0x80) {
        targets.add(nfc);
      }
    }

    expect([...targets].sort()).toEqual([";", "K", "`"]);
  }, 60_000);

  it.each([
    ["ASCII", "01 Title.flac", true],
    ["ASCII with a K", "Kraftwerk", false],
    ["ASCII with a semicolon", "a;b.flac", false],
    ["ASCII with a backtick", "a`b.flac", false],
    ["a composed letter", "Bj\u00f6rk", false],
    ["CJK", "坂本龍一", false],
  ])("has one spelling, or not: %s", (_, segment, one) => {
    expect(hasOneSpelling(segment)).toBe(one);
  });

  it.each([
    ["an ASCII name, whole", "01 Title.flac", "01 Title.flac"],
    ["up to a composed letter", "Bj\u00f6rk", "Bj"],
    ["nothing before a leading accent", "\u00c9dith Piaf", ""],
    ["up to a K", "Das Kabinett", "Das "],
    ["nothing before CJK", "坂本龍一", ""],
  ])("starts every spelling with its one-spelling prefix: %s", (_, segment, prefix) => {
    expect(oneSpellingPrefix(segment)).toBe(prefix);
  });

  it("puts that prefix at the start of every spelling, composed, decomposed or mixed", () => {
    for (const nfc of ["Bj\u00f6rk", "\u00c9dith Piaf", "01 J\u00f3ga \u00e9t\u00e9.flac"]) {
      const prefix = oneSpellingPrefix(nfc);
      const mixed = nfc.replace("\u00e9", "e\u0301");
      for (const spelling of [nfc, nfc.normalize("NFD"), mixed]) {
        expect(spelling.normalize("NFC")).toBe(nfc);
        expect(spelling.startsWith(prefix)).toBe(true);
      }
    }
  });

  it("tells ASCII apart without normalising", () => {
    expect(isAscii("Artist/01.flac")).toBe(true);
    expect(isAscii("Bj\u00f6rk")).toBe(false);
    expect(isAscii("")).toBe(true);
  });
});
