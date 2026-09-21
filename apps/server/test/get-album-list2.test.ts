import { albumId, artistId, prefixedId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browseXml } from "./browsing-support";
import { adminUserId, albumNames, list, listAs } from "./lists-support";
import { seedAlbum, seedAnnotation, seedArtist, seedUser } from "./support";

/**
 * `getAlbumList2`: which albums a type selects, and in what order.
 *
 * The seeds are chosen so that no two orderings agree - creation order, album
 * name and artist name each shuffle the list differently - and one album is
 * deliberately named in lower case, because Navidrome sorts on a lowercased
 * column and a plain byte comparison would file it after every capitalised
 * name.
 */

const SEEDED = new Date(1_700_000_000_000);

/** Minutes after `SEEDED`, so a test can say "added later" readably. */
function created(minutes: number): Date {
  return new Date(SEEDED.getTime() + minutes * 60_000);
}

const ALBUMS = [
  { name: "Aurora", albumArtist: "Zephyr", year: 1999, genre: "Ambient", createdAt: created(20) },
  {
    name: "Beacon",
    albumArtist: "Meridian",
    year: 2005,
    genre: "Electronic",
    createdAt: created(0),
  },
  {
    name: "cinder",
    albumArtist: "Meridian",
    year: 1999,
    genre: "Electronic",
    createdAt: created(40),
  },
  { name: "Delta", albumArtist: "Aster", year: 2011, genre: "Ambient", createdAt: created(10) },
  {
    name: "Echo & Ash",
    albumArtist: "Borealis",
    year: 2020,
    genre: "Jazz",
    createdAt: created(30),
  },
  { name: "Fathom", albumArtist: "Nimbus", year: null, genre: null, createdAt: created(50) },
];

const ALL_NAMES = ALBUMS.map((album) => album.name);

/** A seeded album's client-facing id. */
function idOf(name: string): string {
  const album = ALBUMS.find((candidate) => candidate.name === name);
  if (!album) {
    throw new Error(`no seeded album named ${name}`);
  }

  return prefixedId("album", albumId(album.albumArtist, album.name, album.year));
}

let admin = "";

beforeAll(async () => {
  await bootstrapAdmin();
  admin = await adminUserId();

  for (const name of new Set(ALBUMS.map((album) => album.albumArtist))) {
    await seedArtist({ name });
  }
  for (const album of ALBUMS) {
    await seedAlbum({ ...album, songCount: 2, duration: 123.6 });
  }
});

describe("getAlbumList2 orderings", () => {
  it("lists the most recently added first for newest", async () => {
    expect(albumNames(await list("getAlbumList2", { type: "newest" }))).toEqual([
      "Fathom",
      "cinder",
      "Echo & Ash",
      "Aurora",
      "Delta",
      "Beacon",
    ]);
  });

  it("ignores case for alphabeticalByName, as Navidrome's sort column does", async () => {
    expect(albumNames(await list("getAlbumList2", { type: "alphabeticalByName" }))).toEqual(
      ALL_NAMES,
    );
  });

  it("orders by artist, then by album, for alphabeticalByArtist", async () => {
    expect(albumNames(await list("getAlbumList2", { type: "alphabeticalByArtist" }))).toEqual([
      "Delta",
      "Echo & Ash",
      "Beacon",
      "cinder",
      "Fathom",
      "Aurora",
    ]);
  });

  it("returns every album for random, whatever the order", async () => {
    const names = albumNames(await list("getAlbumList2", { type: "random", size: "500" }));

    expect([...names].sort()).toEqual([...ALL_NAMES].sort());
  });
});

describe("getAlbumList2 byYear", () => {
  it("keeps the albums inside the range, oldest first", async () => {
    const body = await list("getAlbumList2", { type: "byYear", fromYear: "1999", toYear: "2011" });

    expect(albumNames(body)).toEqual(["Aurora", "cinder", "Beacon", "Delta"]);
  });

  it("reads a reversed range as newest first, as Navidrome does", async () => {
    const body = await list("getAlbumList2", { type: "byYear", fromYear: "2011", toYear: "1999" });

    expect(albumNames(body)).toEqual(["Delta", "Beacon", "cinder", "Aurora"]);
  });

  it("leaves out an album with no year when the range does not cover zero", async () => {
    const body = await list("getAlbumList2", { type: "byYear", fromYear: "1", toYear: "9999" });

    expect(albumNames(body)).not.toContain("Fathom");
  });

  it("includes an album with no year when the range covers zero, as year 0 does", async () => {
    const body = await list("getAlbumList2", { type: "byYear", fromYear: "0", toYear: "9999" });

    expect(albumNames(body)).toEqual([
      "Fathom",
      "Aurora",
      "cinder",
      "Beacon",
      "Delta",
      "Echo & Ash",
    ]);
  });

  it("includes it from the other end of a reversed range too", async () => {
    const body = await list("getAlbumList2", { type: "byYear", fromYear: "9999", toYear: "0" });

    expect(albumNames(body)).toEqual([
      "Echo & Ash",
      "Delta",
      "Beacon",
      "cinder",
      "Aurora",
      "Fathom",
    ]);
  });

  it("includes it for a range that is only zero", async () => {
    const body = await list("getAlbumList2", { type: "byYear", fromYear: "0", toYear: "0" });

    expect(albumNames(body)).toEqual(["Fathom"]);
  });

  it("rejects a bound no 64-bit integer can hold, as Go's ParseInt does", async () => {
    const body = await list("getAlbumList2", {
      type: "byYear",
      fromYear: "0",
      toYear: "99999999999999999999",
    });

    expect(body.error).toEqual({
      code: 0,
      message: "invalid parameter 'toYear': expected integer, got '99999999999999999999'",
    });
  });

  it("answers a range nothing falls in with an empty list, not an error", async () => {
    const body = await list("getAlbumList2", { type: "byYear", fromYear: "1950", toYear: "1960" });

    expect(body.status).toBe("ok");
    expect(body.albumList2).toEqual({});
  });

  it("needs both bounds", async () => {
    const body = await list("getAlbumList2", { type: "byYear", fromYear: "1999" });

    expect(body.error).toEqual({ code: 10, message: "missing parameter: 'toYear'" });
  });

  it("rejects a bound that is not a number as an invalid parameter", async () => {
    const body = await list("getAlbumList2", {
      type: "byYear",
      fromYear: "recently",
      toYear: "2011",
    });

    expect(body.error).toEqual({
      code: 0,
      message: "invalid parameter 'fromYear': expected integer, got 'recently'",
    });
  });
});

describe("getAlbumList2 byGenre", () => {
  it("keeps the albums of that genre, by name", async () => {
    const body = await list("getAlbumList2", { type: "byGenre", genre: "Electronic" });

    expect(albumNames(body)).toEqual(["Beacon", "cinder"]);
  });

  it("matches the genre whatever its case, as Navidrome's LIKE does", async () => {
    const body = await list("getAlbumList2", { type: "byGenre", genre: "eLeCtRoNiC" });

    expect(albumNames(body)).toEqual(["Beacon", "cinder"]);
  });

  it("answers an unknown genre with an empty list", async () => {
    const body = await list("getAlbumList2", { type: "byGenre", genre: "Gagaku" });

    expect(body.status).toBe("ok");
    expect(body.albumList2).toEqual({});
  });

  it("needs the genre", async () => {
    const body = await list("getAlbumList2", { type: "byGenre" });

    expect(body.error).toEqual({ code: 10, message: "missing parameter: 'genre'" });
  });
});

describe("getAlbumList2 starred", () => {
  it("is empty while nobody has starred anything", async () => {
    const body = await list("getAlbumList2", { type: "starred" });

    expect(body.status).toBe("ok");
    expect(body.albumList2).toEqual({});
  });

  it("returns the caller's starred albums, most recently starred first", async () => {
    await seedAnnotation({
      userId: admin,
      itemId: albumId("Meridian", "Beacon", 2005),
      itemType: "album",
      starredAt: created(5),
    });
    await seedAnnotation({
      userId: admin,
      itemId: albumId("Aster", "Delta", 2011),
      itemType: "album",
      starredAt: created(9),
    });

    expect(albumNames(await list("getAlbumList2", { type: "starred" }))).toEqual([
      "Delta",
      "Beacon",
    ]);
  });

  it("does not leak another user's stars", async () => {
    const other = await seedUser("listener", "open-sesame");
    await seedAnnotation({
      userId: other,
      itemId: albumId("Zephyr", "Aurora", 1999),
      itemType: "album",
      starredAt: created(99),
    });

    const theirs = await listAs({ user: "listener", password: "open-sesame" }, "getAlbumList2", {
      type: "starred",
    });

    expect(albumNames(await list("getAlbumList2", { type: "starred" }))).not.toContain("Aurora");
    expect(albumNames(theirs)).toEqual(["Aurora"]);
  });

  it("ignores a row that records something other than a star", async () => {
    await seedAnnotation({
      userId: admin,
      itemId: albumId("Nimbus", "Fathom", null),
      itemType: "album",
      starred: false,
      rating: 5,
    });

    expect(albumNames(await list("getAlbumList2", { type: "starred" }))).not.toContain("Fathom");
  });
});

describe("getAlbumList2 types", () => {
  it.each(["recent", "frequent", "highest"])(
    "answers %s with an empty list rather than an error",
    async (type) => {
      const body = await list("getAlbumList2", { type });

      expect(body.status).toBe("ok");
      expect(body.albumList2).toEqual({});
    },
  );

  it("needs a type", async () => {
    const body = await list("getAlbumList2");

    expect(body.error).toEqual({ code: 10, message: "missing parameter: 'type'" });
  });

  it("says a type nobody implements is not implemented", async () => {
    const body = await list("getAlbumList2", { type: "byMood" });

    expect(body.error).toEqual({ code: 0, message: "type 'byMood' not implemented" });
  });
});

describe("getAlbumList2 responses", () => {
  it.each(["/rest/getAlbumList2", "/rest/getAlbumList2.view"])("answers on %s", async (path) => {
    const xml = await browseXml(path, { type: "alphabeticalByName", size: "1" });

    expect(xml).toContain('status="ok"');
    expect(xml).toContain("<albumList2>");
  });

  it("renders the album's attributes in Navidrome's order, escaping the text", async () => {
    const xml = await browseXml("/rest/getAlbumList2", { type: "newest", offset: "2", size: "1" });

    expect(xml).toContain(
      `<album id="${idOf("Echo & Ash")}" name="Echo &amp; Ash" artist="Borealis"` +
        ` artistId="${prefixedId("artist", artistId("Borealis"))}"` +
        ' songCount="2" duration="123" created="2023-11-14T22:43:20.000Z"' +
        ' year="2020" genre="Jazz"/>',
    );
  });

  it("omits coverArt from an album that has none", async () => {
    const xml = await browseXml("/rest/getAlbumList2", { type: "newest" });

    expect(xml).not.toContain("coverArt=");
  });

  it("carries the album's prefixed id in JSON", async () => {
    const body = await list("getAlbumList2", { type: "alphabeticalByName", size: "1" });

    expect(body.albumList2?.album?.[0]?.id).toBe(idOf("Aurora"));
  });

  it("accepts the one music folder and rejects any other", async () => {
    const mine = await list("getAlbumList2", { type: "newest", musicFolderId: "1" });
    const theirs = await list("getAlbumList2", { type: "newest", musicFolderId: "7" });

    expect(albumNames(mine)).toHaveLength(ALBUMS.length);
    expect(theirs.error).toEqual({ code: 70, message: "Library 7 not found or not accessible" });
  });
});
