import { type Album, album, albumId, artistId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { bootstrapAdmin } from "./browsing-support";
import { albumNames, list } from "./lists-support";
import { SEED_TIME, testEnv } from "./support";

/**
 * `size` and `offset` on `getAlbumList2`.
 *
 * The cap is 500, so proving it needs more than 500 albums: this file seeds
 * 501, named so that `alphabeticalByName` puts them in a known order and a
 * test can say exactly which page it expects. They go in several rows at a
 * time rather than one at a time, so the seed is tens of statements rather
 * than hundreds.
 */

const ALBUM_COUNT = 501;
const ARTIST = "Paged";

/**
 * How many albums one insert carries. D1 allows at most a hundred bound
 * parameters in a statement and an album has twelve columns, so eight rows
 * is the most that fits.
 */
const ROWS_PER_INSERT = 8;

/** `Album 000` … `Album 500`, which sort in the order they are numbered. */
function albumName(index: number): string {
  return `Album ${String(index).padStart(3, "0")}`;
}

beforeAll(async () => {
  await bootstrapAdmin();

  const rows: Album[] = Array.from({ length: ALBUM_COUNT }, (_, index) => ({
    id: albumId(ARTIST, albumName(index), 2000),
    name: albumName(index),
    artistId: artistId(ARTIST),
    albumArtist: ARTIST,
    year: 2000,
    genre: null,
    songCount: 1,
    duration: 1,
    size: 1,
    coverKey: null,
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
  }));

  const db = database(testEnv);
  for (let start = 0; start < rows.length; start += ROWS_PER_INSERT) {
    await db.insert(album).values(rows.slice(start, start + ROWS_PER_INSERT));
  }
});

/** One page of the alphabetical list. */
async function page(extra: Record<string, string>): Promise<string[]> {
  return albumNames(await list("getAlbumList2", { type: "alphabeticalByName", ...extra }));
}

describe("getAlbumList2 paging", () => {
  it("returns ten albums when the client does not ask for a size", async () => {
    expect(await page({})).toHaveLength(10);
  });

  it("returns as many as the client asked for", async () => {
    expect(await page({ size: "3" })).toEqual(["Album 000", "Album 001", "Album 002"]);
  });

  it("never returns more than five hundred, however large the size", async () => {
    expect(await page({ size: "100000" })).toHaveLength(500);
  });

  it("falls back to ten when the size is not a number", async () => {
    expect(await page({ size: "plenty" })).toHaveLength(10);
  });

  it("falls back to ten for a size no 64-bit integer can hold", async () => {
    // Go's `ParseInt` reports this out of range and `IntOr` answers with the
    // default; parsed as a float it would round to 1e20 and cap to 500.
    expect(await page({ size: "99999999999999999999" })).toHaveLength(10);
  });

  it("returns nothing for a size of zero, rather than the whole library", async () => {
    const body = await list("getAlbumList2", { type: "alphabeticalByName", size: "0" });

    expect(body.status).toBe("ok");
    expect(body.albumList2).toEqual({});
  });

  it("treats a negative size as zero", async () => {
    expect(await page({ size: "-4" })).toEqual([]);
  });

  it("starts the page at the offset", async () => {
    expect(await page({ size: "2", offset: "3" })).toEqual(["Album 003", "Album 004"]);
  });

  it("returns the remainder when the offset runs into the end of the list", async () => {
    expect(await page({ size: "5", offset: "499" })).toEqual(["Album 499", "Album 500"]);
  });

  it("answers an offset past the end with an empty list", async () => {
    const body = await list("getAlbumList2", {
      type: "alphabeticalByName",
      offset: String(ALBUM_COUNT),
    });

    expect(body.status).toBe("ok");
    expect(body.albumList2).toEqual({});
  });

  it("ignores a negative offset, as Navidrome ignores it", async () => {
    expect(await page({ size: "1", offset: "-10" })).toEqual(["Album 000"]);
  });

  it("pages without repeating or skipping an album", async () => {
    const first = await page({ size: "4" });
    const second = await page({ size: "4", offset: "4" });

    expect([...first, ...second]).toEqual([
      "Album 000",
      "Album 001",
      "Album 002",
      "Album 003",
      "Album 004",
      "Album 005",
      "Album 006",
      "Album 007",
    ]);
  });
});
