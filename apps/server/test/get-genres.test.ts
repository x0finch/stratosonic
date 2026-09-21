import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browse, browseXml } from "./browsing-support";
import { seedTrack } from "./support";

/**
 * `getGenres`: what the library's tracks are tagged with, how many songs
 * carry each tag and how many albums they add up to.
 */

/** Three genres, one of them spelled with a character XML cares about. */
const TRACKS = [
  { album: "Pulse", genre: "Electronic" },
  { album: "Pulse", genre: "Electronic" },
  { album: "Drift", genre: "Electronic" },
  { album: "Drift", genre: "Ambient" },
  { album: "Breaks", genre: "Drum & Bass" },
  { album: "Steps", genre: "Drum & Bass" },
  { album: "Steps", genre: "" },
  { album: "Steps", genre: null },
];

beforeAll(async () => {
  await bootstrapAdmin();

  for (const [index, entry] of TRACKS.entries()) {
    await seedTrack({
      r2Key: `Genre Artist/${entry.album}/${index} Track.mp3`,
      album: entry.album,
      albumArtist: "Genre Artist",
      genre: entry.genre,
    });
  }
});

describe("getGenres", () => {
  it.each(["/rest/getGenres", "/rest/getGenres.view"])("answers on %s", async (path) => {
    const xml = await browseXml(path);

    expect(xml).toContain('status="ok"');
    expect(xml).toContain('<genre songCount="3" albumCount="2">Electronic</genre>');
  });

  it("counts the songs and the albums of each genre", async () => {
    const genres = (await browse("getGenres")).genres?.genre;

    expect(genres).toEqual([
      { value: "Electronic", songCount: 3, albumCount: 2 },
      { value: "Drum & Bass", songCount: 2, albumCount: 2 },
      { value: "<Empty>", songCount: 1, albumCount: 1 },
      { value: "Ambient", songCount: 1, albumCount: 1 },
    ]);
  });

  it("names a genre with an empty tag <Empty>, as Navidrome does", async () => {
    const genres = (await browse("getGenres")).genres?.genre ?? [];

    expect(genres.map((genre) => genre.value)).toContain("<Empty>");
  });

  it("is not a genre when the track has no genre tag at all", async () => {
    const genres = (await browse("getGenres")).genres?.genre ?? [];
    const counted = genres.reduce((total, genre) => total + genre.songCount, 0);

    expect(counted).toBe(TRACKS.filter((entry) => entry.genre !== null).length);
  });

  it("escapes a name in the element's text", async () => {
    const xml = await browseXml("/rest/getGenres");

    expect(xml).toContain('<genre songCount="2" albumCount="2">Drum &amp; Bass</genre>');
    expect(xml).toContain('<genre songCount="1" albumCount="1">&lt;Empty&gt;</genre>');
  });
});
