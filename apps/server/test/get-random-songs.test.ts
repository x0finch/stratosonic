import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browseXml } from "./browsing-support";
import { list } from "./lists-support";
import { seedAlbum, seedArtist, seedTrack } from "./support";

/**
 * `getRandomSongs`: a handful of tracks, optionally narrowed the way
 * Navidrome narrows them - by genre name and by an inclusive year range.
 *
 * Randomness is asserted as a set, never as an order: what matters is which
 * tracks may come back and how many, not which one comes first.
 */

const ARTIST = "Shuffle";
const ALBUM = "Deck";

/** Twelve tracks, so the default size of ten is visibly a limit. */
const TRACKS = Array.from({ length: 12 }, (_, index) => ({
  r2Key: `${ARTIST}/${ALBUM}/${String(index).padStart(2, "0")} Card.mp3`,
  genre: index % 2 === 0 ? "Techno" : "Dub",
  year: 2000 + index,
}));

/** The titles a response carries, which is enough to identify each track. */
function titles(songs: { title: string }[] | undefined): string[] {
  return (songs ?? []).map((song) => song.title).sort();
}

/** The title `seedTrack` derives from a key: the file name, without suffix. */
function seededTitles(): string[] {
  return TRACKS.map((seed) => (seed.r2Key.split("/").at(-1) ?? "").replace(/\.mp3$/, "")).sort();
}

beforeAll(async () => {
  await bootstrapAdmin();
  await seedArtist({ name: ARTIST });
  await seedAlbum({ name: ALBUM, albumArtist: ARTIST, year: null, songCount: TRACKS.length });

  for (const seed of TRACKS) {
    await seedTrack({ ...seed, album: ALBUM, albumArtist: ARTIST, duration: 61.7, size: 2048 });
  }
});

describe("getRandomSongs", () => {
  it.each(["/rest/getRandomSongs", "/rest/getRandomSongs.view"])("answers on %s", async (path) => {
    const xml = await browseXml(path, { size: "1" });

    expect(xml).toContain('status="ok"');
    expect(xml).toContain("<randomSongs>");
  });

  it("returns ten songs when the client does not ask for a size", async () => {
    expect((await list("getRandomSongs")).randomSongs?.song).toHaveLength(10);
  });

  it("returns as many as the client asked for", async () => {
    expect((await list("getRandomSongs", { size: "3" })).randomSongs?.song).toHaveLength(3);
  });

  it("returns the whole library when asked for more than it holds", async () => {
    const songs = (await list("getRandomSongs", { size: "500" })).randomSongs?.song;

    expect(titles(songs)).toEqual(seededTitles());
  });

  it("returns nothing for a size of zero, rather than the whole library", async () => {
    const body = await list("getRandomSongs", { size: "0" });

    expect(body.status).toBe("ok");
    expect(body.randomSongs).toEqual({});
  });

  it("falls back to ten when the size is not a number", async () => {
    expect((await list("getRandomSongs", { size: "some" })).randomSongs?.song).toHaveLength(10);
  });

  it("keeps only the tracks of a genre it is given", async () => {
    const songs = (await list("getRandomSongs", { size: "500", genre: "Dub" })).randomSongs?.song;

    expect(songs).toHaveLength(6);
    expect(songs?.every((song) => song.genre === "Dub")).toBe(true);
  });

  it("keeps only the tracks inside a year range", async () => {
    const songs = (await list("getRandomSongs", { size: "500", fromYear: "2004", toYear: "2006" }))
      .randomSongs?.song;

    expect((songs ?? []).map((song) => song.year).sort()).toEqual([2004, 2005, 2006]);
  });

  it("reads a lone fromYear as a lower bound with no upper one", async () => {
    const songs = (await list("getRandomSongs", { size: "500", fromYear: "2009" })).randomSongs
      ?.song;

    expect(songs).toHaveLength(3);
  });

  it("combines the genre and the year range", async () => {
    const songs = (
      await list("getRandomSongs", {
        size: "500",
        genre: "Techno",
        fromYear: "2000",
        toYear: "2003",
      })
    ).randomSongs?.song;

    expect((songs ?? []).map((song) => song.year).sort()).toEqual([2000, 2002]);
  });

  it("answers a genre nothing carries with an empty list, not an error", async () => {
    const body = await list("getRandomSongs", { genre: "Gagaku" });

    expect(body.status).toBe("ok");
    expect(body.randomSongs).toEqual({});
  });

  it("renders a song with a prefixed id, a literal isDir and a fractional timestamp", async () => {
    const song = (await list("getRandomSongs", { size: "500" })).randomSongs?.song?.[0];

    expect(song?.id.startsWith("tr-")).toBe(true);
    expect(song?.albumId?.startsWith("al-")).toBe(true);
    expect(song?.artistId?.startsWith("ar-")).toBe(true);
    expect(song?.isDir).toBe(false);
    expect(song?.created).toBe("2023-11-14T22:13:20.000Z");
  });

  it("writes isDir as a word in XML, never as a number", async () => {
    const xml = await browseXml("/rest/getRandomSongs", { size: "1" });

    expect(xml).toContain('isDir="false"');
    expect(xml).toContain('<song id="tr-');
  });

  it("accepts the one music folder and rejects any other", async () => {
    const mine = await list("getRandomSongs", { size: "1", musicFolderId: "1" });
    const theirs = await list("getRandomSongs", { size: "1", musicFolderId: "7" });

    expect(mine.randomSongs?.song).toHaveLength(1);
    expect(theirs.error).toEqual({ code: 70, message: "Library 7 not found or not accessible" });
  });
});
