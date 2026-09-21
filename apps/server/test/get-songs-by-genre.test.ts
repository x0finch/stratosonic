import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browseXml } from "./browsing-support";
import { list, songTitles } from "./lists-support";
import { seedAlbum, seedArtist, seedTrack } from "./support";

/**
 * `getSongsByGenre`: one genre's songs, by the page.
 *
 * The order has to be stable for `offset` to mean anything, so the seeds give
 * each track a title that says where in the order it belongs, and the tests
 * name the tracks they expect rather than counting them. The cap of 500 is the
 * same `boundedCount` the album lists use and is proved over there
 * (get-album-list2-paging.test.ts), so it is not seeded again here.
 */

const ARTIST = "Quarry";
const ALBUM = "Seams";

/**
 * Five Rock tracks and two Jazz ones. The titles are deliberately out of the
 * order the keys are in, so a test that expects them alphabetically is
 * asserting the ordering rather than the insertion order.
 */
const TRACKS = [
  { title: "Basalt", genre: "Rock" },
  { title: "Granite", genre: "Rock" },
  { title: "Andesite", genre: "Rock" },
  { title: "Elegy", genre: "Jazz" },
  { title: "Dolomite", genre: "Rock" },
  { title: "Chalk", genre: "Rock" },
  { title: "Fugue", genre: "Jazz" },
];

/** The Rock titles in the order the endpoint has to answer with. */
const ROCK = ["Andesite", "Basalt", "Chalk", "Dolomite", "Granite"];

/** One page of the genre, as titles. */
async function page(extra: Record<string, string>): Promise<string[]> {
  const body = await list("getSongsByGenre", { genre: "Rock", ...extra });

  return songTitles(body.songsByGenre?.song);
}

beforeAll(async () => {
  await bootstrapAdmin();
  await seedArtist({ name: ARTIST });
  await seedAlbum({ name: ALBUM, albumArtist: ARTIST, year: null, songCount: TRACKS.length });

  for (const [index, seed] of TRACKS.entries()) {
    await seedTrack({
      r2Key: `${ARTIST}/${ALBUM}/${String(index).padStart(2, "0")} ${seed.title}.mp3`,
      title: seed.title,
      album: ALBUM,
      albumArtist: ARTIST,
      genre: seed.genre,
      duration: 61.7,
      size: 2048,
    });
  }
});

describe("getSongsByGenre", () => {
  it.each(["/rest/getSongsByGenre", "/rest/getSongsByGenre.view"])(
    "answers on %s",
    async (path) => {
      const xml = await browseXml(path, { genre: "Rock", count: "1" });

      expect(xml).toContain('status="ok"');
      expect(xml).toContain("<songsByGenre>");
      expect(xml).toContain('<song id="tr-');
      expect(xml).toContain('isDir="false"');
    },
  );

  it("keeps only the songs of the genre", async () => {
    expect(await page({ count: "500" })).toEqual(ROCK);
  });

  it("returns ten songs at most when the client does not ask for a count", async () => {
    // Seven tracks here, five of them Rock, so the default is not visible as a
    // limit; what it must not do is refuse or truncate below the genre.
    expect(await page({})).toEqual(ROCK);
  });

  it("returns the third and fourth songs of the genre for a page of two", async () => {
    expect(await page({ count: "2", offset: "2" })).toEqual(["Chalk", "Dolomite"]);
  });

  it("matches the genre whatever case the client sends it in", async () => {
    expect(await page({ genre: "rock", count: "2", offset: "2" })).toEqual(["Chalk", "Dolomite"]);
    expect(await page({ genre: "ROCK", count: "500" })).toEqual(ROCK);
  });

  it("pages without repeating or skipping a song", async () => {
    const first = await page({ count: "2" });
    const second = await page({ count: "2", offset: "2" });
    const third = await page({ count: "2", offset: "4" });

    expect([...first, ...second, ...third]).toEqual(ROCK);
  });

  it("answers an offset past the end with an empty list", async () => {
    const body = await list("getSongsByGenre", { genre: "Rock", offset: "99" });

    expect(body.status).toBe("ok");
    expect(body.songsByGenre).toEqual({});
  });

  it("returns nothing for a count of zero, rather than the whole genre", async () => {
    const body = await list("getSongsByGenre", { genre: "Rock", count: "0" });

    expect(body.status).toBe("ok");
    expect(body.songsByGenre).toEqual({});
  });

  it("falls back to ten when the count is not a number", async () => {
    expect(await page({ count: "some" })).toEqual(ROCK);
  });

  it("answers a genre nothing carries with an empty list, not an error", async () => {
    const body = await list("getSongsByGenre", { genre: "Gagaku" });

    expect(body.status).toBe("ok");
    expect(body.error).toBeUndefined();
    expect(body.songsByGenre).toEqual({});
  });

  it("renders an unknown genre as a childless element in XML", async () => {
    const xml = await browseXml("/rest/getSongsByGenre", { genre: "Gagaku" });

    expect(xml).toContain("<songsByGenre/>");
    expect(xml).not.toContain("<error");
  });

  it("refuses a request with no genre", async () => {
    const body = await list("getSongsByGenre");

    expect(body.error).toEqual({ code: 10, message: "missing parameter: 'genre'" });
  });

  it("renders a song with a prefixed id and its album's name", async () => {
    const body = await list("getSongsByGenre", { genre: "Rock", count: "1" });
    const song = body.songsByGenre?.song?.[0];

    expect(song?.id.startsWith("tr-")).toBe(true);
    expect(song?.albumId?.startsWith("al-")).toBe(true);
    expect(song?.album).toBe(ALBUM);
    expect(song?.genre).toBe("Rock");
  });

  it("accepts the one music folder and rejects any other", async () => {
    const mine = await list("getSongsByGenre", { genre: "Rock", count: "1", musicFolderId: "1" });
    const theirs = await list("getSongsByGenre", { genre: "Rock", count: "1", musicFolderId: "7" });

    expect(mine.songsByGenre?.song).toHaveLength(1);
    expect(theirs.error).toEqual({ code: 70, message: "Library 7 not found or not accessible" });
  });
});
