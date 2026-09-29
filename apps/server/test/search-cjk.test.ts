import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin } from "./browsing-support";
import { albumNames, artistNames, search, searchXml, songTitles } from "./search-support";
import { seedAlbum, seedArtist, seedTrack } from "./support";

/**
 * `search2` and `search3` over CJK names (#73).
 *
 * The roadmap made "Chinese search hits" a Phase 2 acceptance criterion; the
 * search shipped as `LIKE '%word%'` rather than FTS5, which matches a
 * non-ASCII word as an exact run of characters. This file proves that holds
 * for Chinese, Japanese and Korean, and pins the two edges that follow from
 * it: a CJK query is split only on whitespace, never into characters, and
 * nothing is Unicode-normalised, so full-width Latin is not half-width Latin.
 *
 * The library: a Chinese artist with a Chinese album and an album whose name
 * mixes CJK and ASCII, a Japanese artist whose name carries katakana and whose
 * one song is titled in full-width Latin letters, a Japanese act with a
 * half-width Latin name and a kana title, and a Korean artist.
 */

interface AlbumSpec {
  readonly artist: string;
  readonly name: string;
  readonly year: number;
}

const CITY_NOCTURNE: AlbumSpec = { artist: "林间晨光", name: "城市夜曲", year: 2019 };
const MORNING_LIVE: AlbumSpec = { artist: "林间晨光", name: "晨光 Live", year: 2021 };
const BUDOKAN: AlbumSpec = { artist: "宇多田ヒカル", name: "Live at Budokan", year: 2004 };
const THE_BOOK: AlbumSpec = { artist: "YOASOBI", name: "THE BOOK", year: 2021 };
const FLOWER_BOOKMARK: AlbumSpec = { artist: "아이유", name: "꽃갈피", year: 2014 };

const ALBUMS: readonly AlbumSpec[] = [
  CITY_NOCTURNE,
  MORNING_LIVE,
  BUDOKAN,
  THE_BOOK,
  FLOWER_BOOKMARK,
];

const TRACKS: readonly { album: AlbumSpec; title: string }[] = [
  { album: CITY_NOCTURNE, title: "以父之名" },
  { album: MORNING_LIVE, title: "Opening" },
  // Full-width Latin letters (U+FF21 block), as some CJK releases tag them.
  { album: BUDOKAN, title: "Ｆｉｒｓｔ Ｌｏｖｅ" },
  { album: THE_BOOK, title: "夜に駆ける" },
  { album: FLOWER_BOOKMARK, title: "좋은 날" },
];

beforeAll(async () => {
  await bootstrapAdmin();

  for (const name of new Set(ALBUMS.map((album) => album.artist))) {
    await seedArtist({ name });
  }
  for (const album of ALBUMS) {
    await seedAlbum({
      name: album.name,
      albumArtist: album.artist,
      year: album.year,
      songCount: 1,
    });
  }
  for (const [index, spec] of TRACKS.entries()) {
    await seedTrack({
      r2Key: `${spec.album.artist}/${spec.album.name}/${index} ${spec.title}.mp3`,
      title: spec.title,
      album: spec.album.name,
      albumArtist: spec.album.artist,
      year: spec.album.year,
    });
  }
});

describe("search3 over Chinese names", () => {
  it("finds a song by two of its title's four characters", async () => {
    const result = (await search("search3", { query: "父之" })).searchResult3;

    expect(songTitles(result)).toEqual(["以父之名"]);
    expect(artistNames(result)).toEqual([]);
    expect(albumNames(result)).toEqual([]);
  });

  it("finds an artist by two of its name's four characters", async () => {
    const result = (await search("search3", { query: "间晨" })).searchResult3;

    expect(artistNames(result)).toEqual(["林间晨光"]);
    // Every album and song of the artist carries the name as its (album)
    // artist, so they are found too, as "beat" finds the Beatles' tracks.
    expect(albumNames(result).sort()).toEqual(["晨光 Live", "城市夜曲"].sort());
    expect(songTitles(result).sort()).toEqual(["Opening", "以父之名"].sort());
  });

  it("finds an album by two of its name's four characters", async () => {
    const result = (await search("search3", { query: "市夜" })).searchResult3;

    expect(albumNames(result)).toEqual(["城市夜曲"]);
    // The song is found through the album name it carries.
    expect(songTitles(result)).toEqual(["以父之名"]);
    expect(artistNames(result)).toEqual([]);
  });

  it("requires both words of a query mixing CJK and ASCII", async () => {
    const result = (await search("search3", { query: "晨光 live" })).searchResult3;

    // Only "晨光 Live" and its song hold both words. 城市夜曲 and 以父之名
    // hold 晨光 (through the artist) but not "live"; Live at Budokan and its
    // song hold "live" but not 晨光; the artist 林间晨光 holds 晨光 alone.
    expect(albumNames(result)).toEqual(["晨光 Live"]);
    expect(songTitles(result)).toEqual(["Opening"]);
    expect(artistNames(result)).toEqual([]);
  });

  it("folds the case of the ASCII word in a mixed query", async () => {
    const result = (await search("search3", { query: "LIVE 晨光" })).searchResult3;

    expect(albumNames(result)).toEqual(["晨光 Live"]);
  });
});

describe("search3 over Japanese and Korean names", () => {
  it.each([
    [
      "katakana",
      "ヒカ",
      { artists: ["宇多田ヒカル"], albums: ["Live at Budokan"], songs: ["Ｆｉｒｓｔ Ｌｏｖｅ"] },
    ],
    ["hiragana", "ける", { artists: [], albums: [], songs: ["夜に駆ける"] }],
    ["kana and kanji", "に駆", { artists: [], albums: [], songs: ["夜に駆ける"] }],
    ["hangul (artist)", "이유", { artists: ["아이유"], albums: ["꽃갈피"], songs: ["좋은 날"] }],
    ["hangul (album)", "갈피", { artists: [], albums: ["꽃갈피"], songs: ["좋은 날"] }],
    ["hangul (song)", "좋은", { artists: [], albums: [], songs: ["좋은 날"] }],
  ])("matches a %s substring", async (_script, query, expected) => {
    const result = (await search("search3", { query })).searchResult3;

    expect(artistNames(result)).toEqual(expected.artists);
    expect(albumNames(result)).toEqual(expected.albums);
    expect(songTitles(result)).toEqual(expected.songs);
  });
});

describe("search3 word splitting for CJK", () => {
  // A query is split on whitespace only. CJK text is written without spaces,
  // so an unspaced CJK query is one word and must occur as one contiguous run:
  // there is no per-character or dictionary tokenisation as FTS would do.

  it("does not match characters that are in a title but not adjacent", async () => {
    // 以 and 名 are both in 以父之名, but "以名" is not a substring of it.
    const result = (await search("search3", { query: "以名" })).searchResult3;

    expect(result).toEqual({});
  });

  it("matches non-adjacent parts once a space splits them into words", async () => {
    const result = (await search("search3", { query: "以 名" })).searchResult3;

    expect(songTitles(result)).toEqual(["以父之名"]);
  });

  it("splits on the ideographic space U+3000 a CJK input method types", async () => {
    // JavaScript's \s includes U+3000, so the full-width space separates words
    // exactly as an ASCII space does.
    const result = (await search("search3", { query: "以　名" })).searchResult3;

    expect(songTitles(result)).toEqual(["以父之名"]);
  });

  it("does not match a spaced Korean title typed without its space", async () => {
    // Korean is written with spaces, so the title is "좋은 날"; "좋은날" is
    // one word that no name contains.
    const result = (await search("search3", { query: "좋은날" })).searchResult3;

    expect(result).toEqual({});
  });

  it("does not match a CJK word run into an ASCII word without a space", async () => {
    const result = (await search("search3", { query: "晨光live" })).searchResult3;

    expect(result).toEqual({});
  });
});

describe("search3 full-width characters", () => {
  // Nothing is Unicode-normalised (no NFKC): SQLite's LIKE compares code
  // points and folds only the ASCII letters. So full-width Latin (U+FF01 to
  // U+FF5E) and half-width katakana are distinct from their ASCII and
  // full-width counterparts, and full-width letters are not case-folded.

  it("matches a full-width title with the same full-width query", async () => {
    const result = (await search("search3", { query: "Ｆｉｒｓｔ" })).searchResult3;

    expect(songTitles(result)).toEqual(["Ｆｉｒｓｔ Ｌｏｖｅ"]);
  });

  it("does not match a full-width title with a half-width query", async () => {
    const result = (await search("search3", { query: "First" })).searchResult3;

    expect(result).toEqual({});
  });

  it("does not match a half-width name with a full-width query", async () => {
    const full = (await search("search3", { query: "ＹＯＡＳＯＢＩ" })).searchResult3;
    const half = (await search("search3", { query: "yoasobi" })).searchResult3;

    expect(full).toEqual({});
    expect(artistNames(half)).toEqual(["YOASOBI"]);
  });

  it("does not fold the case of full-width letters", async () => {
    const result = (await search("search3", { query: "ｆｉｒｓｔ" })).searchResult3;

    expect(result).toEqual({});
  });

  it("does not match full-width katakana with a half-width katakana query", async () => {
    const result = (await search("search3", { query: "ﾋｶﾙ" })).searchResult3;

    expect(result).toEqual({});
  });
});

describe("search2 over CJK names", () => {
  it("finds the same song, artist and album as search3", async () => {
    const song = (await search("search2", { query: "父之" })).searchResult2;
    const artist = (await search("search2", { query: "间晨" })).searchResult2;
    const album = (await search("search2", { query: "市夜" })).searchResult2;

    expect(songTitles(song)).toEqual(["以父之名"]);
    expect((artist?.artist ?? []).map((entry) => entry.name)).toEqual(["林间晨光"]);
    expect((album?.album ?? []).map((entry) => entry.title)).toEqual(["城市夜曲"]);
  });

  it("requires both words of a query mixing CJK and ASCII", async () => {
    const result = (await search("search2", { query: "晨光 live" })).searchResult2;

    expect((result?.album ?? []).map((entry) => entry.title)).toEqual(["晨光 Live"]);
    expect(songTitles(result)).toEqual(["Opening"]);
    expect(result?.artist).toBeUndefined();
  });

  it("matches kana and hangul substrings", async () => {
    const kana = (await search("search2", { query: "ヒカ" })).searchResult2;
    const hangul = (await search("search2", { query: "좋은" })).searchResult2;

    expect((kana?.artist ?? []).map((entry) => entry.name)).toEqual(["宇多田ヒカル"]);
    expect(songTitles(hangul)).toEqual(["좋은 날"]);
  });

  it("does not fold full-width to half-width", async () => {
    const result = (await search("search2", { query: "First" })).searchResult2;

    expect(result).toEqual({});
  });
});

describe("CJK search in XML", () => {
  it("renders search3 hits with their CJK names unescaped", async () => {
    const xml = await searchXml("/rest/search3", { query: "晨光" });

    expect(xml).not.toContain("<error");
    expect(xml).toContain('<artist id="');
    expect(xml).toContain('name="林间晨光"');
    expect(xml).toContain('name="城市夜曲"');
    expect(xml).toContain('title="以父之名"');
  });

  it("renders search2 hits with their CJK names unescaped", async () => {
    const xml = await searchXml("/rest/search2", { query: "晨光 live" });

    expect(xml).toContain("<searchResult2>");
    expect(xml).toContain('title="晨光 Live"');
    expect(xml).toContain('title="Opening"');
    expect(xml).not.toContain('name="林间晨光"');
  });

  it("answers a full-width query with an empty container", async () => {
    const xml = await searchXml("/rest/search3", { query: "ＹＯＡＳＯＢＩ" });

    expect(xml).toContain("<searchResult3/>");
  });
});
