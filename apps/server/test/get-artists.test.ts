import { albumId, artistId, prefixedId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browse, browseXml } from "./browsing-support";
import { seedAlbum, seedArtist } from "./support";

/**
 * `getArtists` against the Worker: the index buckets a client navigates by,
 * the album counts it sizes its sync from, and the cover an artist borrows
 * from its albums.
 */

const ARTICLED = "The Silent Type";
const PLAIN = "Mute Ensemble";
const NUMERIC = "4 Non Blondes";
const ACCENTED = "Éclair Quartet";
const LATE_LETTER = "Zephyr Youth";
const PUNCTUATED = `Salt & Pepper <Live> "Quoted" 'Apostrophed'`;

/** The album whose cover the articled artist should borrow: not its first. */
const COVERED_ALBUM = { name: "Loud Dusk", year: 2001 };

beforeAll(async () => {
  await bootstrapAdmin();

  for (const name of [ARTICLED, PLAIN, NUMERIC, ACCENTED, LATE_LETTER, PUNCTUATED]) {
    await seedArtist({ name });
  }

  // The articled artist has two albums and only the later one has a cover, so
  // "the first album with a cover" is not the same as "the first album".
  await seedAlbum({ name: "Quiet Dawn", albumArtist: ARTICLED, year: 1999, coverKey: null });
  await seedAlbum({
    name: COVERED_ALBUM.name,
    albumArtist: ARTICLED,
    year: COVERED_ALBUM.year,
    coverKey: "_covers/loud-dusk.png",
  });

  await seedAlbum({ name: "Hush", albumArtist: PLAIN, year: 2019 });
  await seedAlbum({ name: "Bigger, Better, Faster, More!", albumArtist: NUMERIC, year: 1992 });
  await seedAlbum({ name: "Late Nights", albumArtist: LATE_LETTER, year: 2020 });
  await seedAlbum({ name: "Seasoned", albumArtist: PUNCTUATED, year: 2021 });
});

describe("getArtists", () => {
  it.each(["/rest/getArtists", "/rest/getArtists.view"])(
    "answers on %s with the ignored articles",
    async (path) => {
      const xml = await browseXml(path);

      expect(xml).toContain('status="ok"');
      expect(xml).toContain('<artists ignoredArticles="The El La Los Las Le Les Os As O A">');
      expect(xml).toContain('<index name="M">');
    },
  );

  it("buckets artists by the letter they sort under, ignoring articles", async () => {
    const body = await browse("getArtists");
    const indexes = body.artists?.index ?? [];

    expect(indexes.map((index) => index.name)).toEqual(["#", "E", "M", "S", "X-Z"]);
    expect(indexes.find((index) => index.name === "#")?.artist.map((a) => a.name)).toEqual([
      NUMERIC,
    ]);
    expect(indexes.find((index) => index.name === "S")?.artist.map((a) => a.name)).toEqual([
      PUNCTUATED,
      ARTICLED,
    ]);
    expect(indexes.find((index) => index.name === "X-Z")?.artist.map((a) => a.name)).toEqual([
      LATE_LETTER,
    ]);
    expect(indexes.find((index) => index.name === "E")?.artist.map((a) => a.name)).toEqual([
      ACCENTED,
    ]);
  });

  it("counts an artist's albums exactly, including none at all", async () => {
    const artists = (await browse("getArtists")).artists?.index?.flatMap((index) => index.artist);
    const counts = Object.fromEntries((artists ?? []).map((a) => [a.name, a.albumCount]));

    expect(counts).toEqual({
      [ARTICLED]: 2,
      [PLAIN]: 1,
      [NUMERIC]: 1,
      [ACCENTED]: 0,
      [LATE_LETTER]: 1,
      [PUNCTUATED]: 1,
    });
  });

  it("gives every artist its prefixed id", async () => {
    const artists = (await browse("getArtists")).artists?.index?.flatMap((index) => index.artist);
    const articled = artists?.find((artist) => artist.name === ARTICLED);

    expect(articled?.id).toBe(prefixedId("artist", artistId(ARTICLED)));
  });

  it("borrows the cover of the artist's first album that has one", async () => {
    const artists = (await browse("getArtists")).artists?.index?.flatMap((index) => index.artist);
    const articled = artists?.find((artist) => artist.name === ARTICLED);

    expect(articled?.coverArt).toBe(
      prefixedId("album", albumId(ARTICLED, COVERED_ALBUM.name, COVERED_ALBUM.year)),
    );
  });

  it("omits coverArt from an artist whose albums have no cover", async () => {
    const artists = (await browse("getArtists")).artists?.index?.flatMap((index) => index.artist);

    expect(artists?.find((artist) => artist.name === PLAIN)).not.toHaveProperty("coverArt");
    expect(artists?.find((artist) => artist.name === ACCENTED)).not.toHaveProperty("coverArt");
  });

  it("serves the whole library for the one folder it has", async () => {
    const body = await browse("getArtists", { musicFolderId: "1" });

    expect(body.status).toBe("ok");
    expect(body.artists?.index).toHaveLength(5);
  });

  it("says error 70 for a folder it does not have", async () => {
    const body = await browse("getArtists", { musicFolderId: "2" });

    expect(body.status).toBe("failed");
    expect(body.error).toEqual({ code: 70, message: "Library 2 not found or not accessible" });
  });

  it("escapes a name that would otherwise break the XML", async () => {
    const xml = await browseXml("/rest/getArtists");

    expect(xml).toContain(
      'name="Salt &amp; Pepper &lt;Live&gt; &quot;Quoted&quot; &apos;Apostrophed&apos;"',
    );
    expect(await browse("getArtists")).toBeDefined();
  });
});
