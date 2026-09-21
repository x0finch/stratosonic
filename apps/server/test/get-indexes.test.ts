import { albumId, artistId, prefixedId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browse, browseXml } from "./browsing-support";
import { seedAlbum, seedArtist } from "./support";

/**
 * `getIndexes`: the artist directories a folder-browsing client navigates,
 * which must be the same buckets `getArtists` answers with — a client that
 * switches views should not see the library reorganize itself.
 *
 * The artists below are the ones `getArtists` is tested with, for exactly
 * that comparison.
 */

const ARTICLED = "The Silent Type";
const PLAIN = "Mute Ensemble";
const NUMERIC = "4 Non Blondes";
const ACCENTED = "Éclair Quartet";
const LATE_LETTER = "Zephyr Youth";

/** The album whose cover the articled artist lends the index: not its first. */
const COVERED_ALBUM = { name: "Loud Dusk", year: 2001 };

/** An hour ahead of the request, so it is after any `lastModified` we send. */
function inTheFuture(): string {
  return String(Date.now() + 3_600_000);
}

beforeAll(async () => {
  await bootstrapAdmin();

  for (const name of [ARTICLED, PLAIN, NUMERIC, ACCENTED, LATE_LETTER]) {
    await seedArtist({ name });
  }

  await seedAlbum({ name: "Quiet Dawn", albumArtist: ARTICLED, year: 1999, coverKey: null });
  await seedAlbum({
    name: COVERED_ALBUM.name,
    albumArtist: ARTICLED,
    year: COVERED_ALBUM.year,
    coverKey: "_covers/loud-dusk.png",
  });
  await seedAlbum({ name: "Hush", albumArtist: PLAIN, year: 2019 });
});

describe("getIndexes", () => {
  it.each(["/rest/getIndexes", "/rest/getIndexes.view"])("answers on %s", async (path) => {
    const xml = await browseXml(path);

    expect(xml).toContain('status="ok"');
    expect(xml).toMatch(
      /<indexes lastModified="\d+" ignoredArticles="The El La Los Las Le Les Os As O A">/,
    );
    expect(xml).toContain('<index name="M">');
  });

  it("dates the library with an instant a client can send back", async () => {
    const before = Date.now();
    const indexes = (await browse("getIndexes")).indexes;

    expect(indexes?.lastModified).toBeGreaterThanOrEqual(before);
    expect(indexes?.lastModified).toBeLessThanOrEqual(Date.now());
  });

  it("buckets the same artists, under the same ids, as getArtists does", async () => {
    const fromIndexes = (await browse("getIndexes")).indexes?.index ?? [];
    const fromArtists = (await browse("getArtists")).artists?.index ?? [];

    const shape = (index: { name: string; artist: { id: string; name: string }[] }) => [
      index.name,
      index.artist.map((artist) => [artist.id, artist.name]),
    ];

    expect(fromIndexes.map(shape)).toEqual(fromArtists.map(shape));
    expect(fromIndexes.map((index) => index.name)).toEqual(["#", "E", "M", "S", "X-Z"]);
  });

  it("gives an artist directory its prefixed id and its borrowed cover", async () => {
    const artists = (await browse("getIndexes")).indexes?.index?.flatMap((index) => index.artist);
    const articled = artists?.find((artist) => artist.name === ARTICLED);

    expect(articled?.id).toBe(prefixedId("artist", artistId(ARTICLED)));
    expect(articled?.coverArt).toBe(
      prefixedId("album", albumId(ARTICLED, COVERED_ALBUM.name, COVERED_ALBUM.year)),
    );
  });

  it("omits coverArt from an artist whose albums have none, and albumCount from all", async () => {
    const artists = (await browse("getIndexes")).indexes?.index?.flatMap((index) => index.artist);

    expect(artists?.find((artist) => artist.name === PLAIN)).not.toHaveProperty("coverArt");
    expect(artists?.find((artist) => artist.name === ACCENTED)).not.toHaveProperty("coverArt");
    // `Artist` is not `ArtistID3`: it carries no count.
    expect(artists?.find((artist) => artist.name === ARTICLED)).not.toHaveProperty("albumCount");
  });

  it("serves the whole library for the folder it has", async () => {
    const body = await browse("getIndexes", { musicFolderId: "1" });

    expect(body.status).toBe("ok");
    expect(body.indexes?.index).toHaveLength(5);
  });

  it("says error 70 for a folder it does not have", async () => {
    const body = await browse("getIndexes", { musicFolderId: "2" });

    expect(body.status).toBe("failed");
    expect(body.error).toEqual({ code: 70, message: "Library 2 not found or not accessible" });
  });

  it("ignores a musicFolderId that is not a number, as Navidrome's parser does", async () => {
    const body = await browse("getIndexes", { musicFolderId: "everything" });

    expect(body.status).toBe("ok");
    expect(body.indexes?.index).toHaveLength(5);
  });

  it("leaves the artists out when the client already has them", async () => {
    const body = await browse("getIndexes", { ifModifiedSince: inTheFuture() });

    expect(body.status).toBe("ok");
    expect(body.indexes?.ignoredArticles).toBe("The El La Los Las Le Les Os As O A");
    expect(body.indexes?.lastModified).toBeGreaterThan(0);
    expect(body.indexes).not.toHaveProperty("index");
  });

  it("keeps an ifModifiedSince past 2^53 in the future, as Go's int64 does", async () => {
    // Larger than Number.MAX_SAFE_INTEGER and still an int64, so reading it as
    // a JavaScript number would round it - away from the far future in which
    // the client says it already has this library.
    const body = await browse("getIndexes", { ifModifiedSince: "9007199254740993" });

    expect(body.status).toBe("ok");
    expect(body.indexes).not.toHaveProperty("index");
  });

  it("sends the artists when ifModifiedSince is too large to be an int64", async () => {
    const body = await browse("getIndexes", { ifModifiedSince: "9223372036854775808" });

    expect(body.indexes?.index).toHaveLength(5);
  });

  it("still renders a well-formed element when it leaves them out", async () => {
    const xml = await browseXml("/rest/getIndexes", { ifModifiedSince: inTheFuture() });

    expect(xml).toMatch(
      /<indexes lastModified="\d+" ignoredArticles="The El La Los Las Le Les Os As O A"\/>/,
    );
  });

  it.each([
    ["absent", {}],
    ["-1", { ifModifiedSince: "-1" }],
    ["the epoch", { ifModifiedSince: "0" }],
    ["not a number", { ifModifiedSince: "yesterday" }],
    ["empty", { ifModifiedSince: "" }],
  ])("sends the artists when ifModifiedSince is %s", async (_case, extra) => {
    const body = await browse("getIndexes", extra);

    expect(body.indexes?.index).toHaveLength(5);
  });
});
