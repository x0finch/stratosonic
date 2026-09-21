import { albumId, artistId, prefixedId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browse, browseXml } from "./browsing-support";
import { SEED_TIME, seedAlbum, seedArtist } from "./support";

/**
 * `getArtist`: one artist and the albums it is the album artist of, in the
 * order a client shows them.
 */

const PROLIFIC = "Prolific One";
const QUIET = "Quiet One";

/** Out of order on purpose: the endpoint decides the order, not the seed. */
const ALBUMS = [
  { name: "Third", year: 2005, coverKey: "_covers/third.png" },
  { name: "First", year: 1999, coverKey: null },
  { name: "Second", year: 2001, coverKey: "_covers/second.png" },
  { name: "Yearless", year: null, coverKey: null },
];

function artistUrlId(name: string): string {
  return prefixedId("artist", artistId(name));
}

beforeAll(async () => {
  await bootstrapAdmin();

  await seedArtist({ name: PROLIFIC });
  await seedArtist({ name: QUIET });

  for (const album of ALBUMS) {
    await seedAlbum({
      name: album.name,
      albumArtist: PROLIFIC,
      year: album.year,
      genre: "Ambient",
      songCount: 2,
      duration: 431.6,
      coverKey: album.coverKey,
    });
  }
});

describe("getArtist", () => {
  it.each(["/rest/getArtist", "/rest/getArtist.view"])("answers on %s", async (path) => {
    const xml = await browseXml(path, { id: artistUrlId(PROLIFIC) });

    expect(xml).toContain('status="ok"');
    expect(xml).toContain(`<artist id="${artistUrlId(PROLIFIC)}" name="${PROLIFIC}"`);
    expect(xml).toContain('<album id="al-');
  });

  it("carries the artist's own attributes, cover included", async () => {
    const artist = (await browse("getArtist", { id: artistUrlId(PROLIFIC) })).artist;

    expect(artist?.id).toBe(artistUrlId(PROLIFIC));
    expect(artist?.name).toBe(PROLIFIC);
    expect(artist?.albumCount).toBe(ALBUMS.length);
    // The first album with a cover in the order below, which is not the first
    // album and not the first one seeded.
    expect(artist?.coverArt).toBe(prefixedId("album", albumId(PROLIFIC, "Second", 2001)));
  });

  it("lists the albums by year and then by name", async () => {
    const artist = (await browse("getArtist", { id: artistUrlId(PROLIFIC) })).artist;

    expect(artist?.album?.map((album) => album.name)).toEqual([
      "Yearless",
      "First",
      "Second",
      "Third",
    ]);
  });

  it("renders each album as the shared album element", async () => {
    const albums = (await browse("getArtist", { id: artistUrlId(PROLIFIC) })).artist?.album ?? [];
    const second = albums.find((album) => album.name === "Second");

    expect(second).toEqual({
      id: prefixedId("album", albumId(PROLIFIC, "Second", 2001)),
      name: "Second",
      artist: PROLIFIC,
      artistId: artistUrlId(PROLIFIC),
      coverArt: prefixedId("album", albumId(PROLIFIC, "Second", 2001)),
      songCount: 2,
      duration: 431,
      created: SEED_TIME.toISOString(),
      year: 2001,
      genre: "Ambient",
    });
  });

  it("omits coverArt from an album that has none, and from a yearless one its year", async () => {
    const albums = (await browse("getArtist", { id: artistUrlId(PROLIFIC) })).artist?.album ?? [];
    const yearless = albums.find((album) => album.name === "Yearless");

    expect(yearless).not.toHaveProperty("coverArt");
    expect(yearless).not.toHaveProperty("year");
  });

  it("answers for an artist with no albums at all, without inventing children", async () => {
    const body = await browse("getArtist", { id: artistUrlId(QUIET) });

    expect(body.status).toBe("ok");
    expect(body.artist?.albumCount).toBe(0);
    expect(body.artist).not.toHaveProperty("album");
    expect(body.artist).not.toHaveProperty("coverArt");
  });
});
