import { albumId, artistId, playlistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browse, browseXml } from "./browsing-support";
import { SEED_TIME, seedAlbum, seedArtist, seedTrack } from "./support";

/**
 * `getMusicDirectory`: the two directories the library has — an artist
 * holding its albums, and an album holding its tracks.
 *
 * The attribute order matters here and is asserted against rendered XML: it
 * is the order Navidrome's `Directory` and `Child` structs declare, and a
 * client written against one server's output should parse the other's.
 */

const ARTIST = "Directory Artist";
const BARE = "Bare Artist";
const COVERED = { name: "Covered", year: 2001, coverKey: "_covers/covered.png", genre: "Ambient" };
const UNCOVERED = { name: "Uncovered", year: 2005, coverKey: null, genre: null };
const ALBUMS = [COVERED, UNCOVERED];

/** Two tracks in the covered album, seeded out of play order on purpose. */
const TRACKS = [
  { title: "Second Song", trackNumber: 2 },
  { title: "First Song", trackNumber: 1 },
];

function artistUrlId(name: string): string {
  return prefixedId("artist", artistId(name));
}

function albumUrlId(name: string, year: number): string {
  return prefixedId("album", albumId(ARTIST, name, year));
}

function r2KeyOf(title: string): string {
  return `${ARTIST}/${COVERED.name}/${title}.mp3`;
}

beforeAll(async () => {
  await bootstrapAdmin();

  await seedArtist({ name: ARTIST });
  await seedArtist({ name: BARE });

  for (const album of ALBUMS) {
    await seedAlbum({
      name: album.name,
      albumArtist: ARTIST,
      year: album.year,
      genre: album.genre,
      songCount: album.coverKey === null ? 0 : TRACKS.length,
      duration: album.coverKey === null ? 0 : 425.7,
      coverKey: album.coverKey,
    });
  }

  for (const song of TRACKS) {
    await seedTrack({
      r2Key: r2KeyOf(song.title),
      title: song.title,
      album: COVERED.name,
      albumArtist: ARTIST,
      year: COVERED.year,
      genre: COVERED.genre,
      trackNumber: song.trackNumber,
      duration: 212.85,
    });
  }
});

describe("getMusicDirectory of an artist", () => {
  it.each(["/rest/getMusicDirectory", "/rest/getMusicDirectory.view"])(
    "answers on %s",
    async (path) => {
      const xml = await browseXml(path, { id: artistUrlId(ARTIST) });

      expect(xml).toContain('status="ok"');
      expect(xml).toContain(
        `<directory id="${artistUrlId(ARTIST)}" name="${ARTIST}" albumCount="2">`,
      );
    },
  );

  it("lists its albums as sub-directories, in the order getArtist lists them", async () => {
    const directory = (await browse("getMusicDirectory", { id: artistUrlId(ARTIST) })).directory;

    expect(directory?.id).toBe(artistUrlId(ARTIST));
    expect(directory?.name).toBe(ARTIST);
    expect(directory?.albumCount).toBe(ALBUMS.length);
    expect(directory).not.toHaveProperty("parent");
    expect(directory?.child?.map((child) => child.name)).toEqual(["Covered", "Uncovered"]);
  });

  it("says an album is a directory and whose it is", async () => {
    const directory = (await browse("getMusicDirectory", { id: artistUrlId(ARTIST) })).directory;
    const covered = directory?.child?.[0];

    expect(covered?.id).toBe(albumUrlId("Covered", 2001));
    expect(covered?.isDir).toBe(true);
    expect(covered?.parent).toBe(artistUrlId(ARTIST));
    expect(covered?.artistId).toBe(artistUrlId(ARTIST));
    expect(covered?.title).toBe("Covered");
    expect(covered?.album).toBe("Covered");
    expect(covered?.artist).toBe(ARTIST);
    expect(covered?.year).toBe(2001);
    expect(covered?.genre).toBe("Ambient");
    expect(covered?.coverArt).toBe(albumUrlId("Covered", 2001));
    expect(covered?.songCount).toBe(TRACKS.length);
    expect(covered?.created).toBe(SEED_TIME.toISOString());
  });

  it("writes isDir as the literal word, with the attributes in Navidrome's order", async () => {
    const xml = await browseXml("/rest/getMusicDirectory", { id: artistUrlId(ARTIST) });

    expect(xml).toContain(
      `<child id="${albumUrlId("Covered", 2001)}" parent="${artistUrlId(ARTIST)}" isDir="true"` +
        ` title="Covered" name="Covered" album="Covered" artist="${ARTIST}" year="2001"` +
        ` genre="Ambient" coverArt="${albumUrlId("Covered", 2001)}" duration="425"` +
        ` created="${SEED_TIME.toISOString()}" artistId="${artistUrlId(ARTIST)}" songCount="2"/>`,
    );
  });

  it("omits coverArt, genre, duration and songCount from an album that has none", async () => {
    const directory = (await browse("getMusicDirectory", { id: artistUrlId(ARTIST) })).directory;
    const uncovered = directory?.child?.[1];

    expect(uncovered?.id).toBe(albumUrlId("Uncovered", 2005));
    expect(uncovered?.isDir).toBe(true);
    expect(uncovered).not.toHaveProperty("coverArt");
    expect(uncovered).not.toHaveProperty("genre");
    expect(uncovered).not.toHaveProperty("duration");
    expect(uncovered).not.toHaveProperty("songCount");
  });

  it("answers an artist with no albums with a childless directory", async () => {
    const body = await browse("getMusicDirectory", { id: artistUrlId(BARE) });

    expect(body.status).toBe("ok");
    expect(body.directory?.name).toBe(BARE);
    expect(body.directory).not.toHaveProperty("child");
    expect(body.directory).not.toHaveProperty("albumCount");
    expect(await browseXml("/rest/getMusicDirectory", { id: artistUrlId(BARE) })).toContain(
      `<directory id="${artistUrlId(BARE)}" name="${BARE}"/>`,
    );
  });
});

describe("getMusicDirectory of an album", () => {
  it("lists its tracks as children, in the order the record plays", async () => {
    const directory = (await browse("getMusicDirectory", { id: albumUrlId("Covered", 2001) }))
      .directory;

    expect(directory?.id).toBe(albumUrlId("Covered", 2001));
    expect(directory?.name).toBe("Covered");
    expect(directory?.parent).toBe(artistUrlId(ARTIST));
    expect(directory?.coverArt).toBe(albumUrlId("Covered", 2001));
    expect(directory?.songCount).toBe(TRACKS.length);
    expect(directory?.child?.map((child) => child.title)).toEqual(["First Song", "Second Song"]);
  });

  it("says a track is not a directory and which album it is in", async () => {
    const directory = (await browse("getMusicDirectory", { id: albumUrlId("Covered", 2001) }))
      .directory;
    const first = directory?.child?.[0];

    expect(first?.id).toBe(prefixedId("track", trackId(r2KeyOf("First Song"))));
    expect(first?.isDir).toBe(false);
    expect(first?.parent).toBe(albumUrlId("Covered", 2001));
    expect(first?.albumId).toBe(albumUrlId("Covered", 2001));
    expect(first?.artistId).toBe(artistUrlId(ARTIST));
  });

  it("writes the album directory and its isDir=false children in XML", async () => {
    const xml = await browseXml("/rest/getMusicDirectory", { id: albumUrlId("Covered", 2001) });

    expect(xml).toContain(
      `<directory id="${albumUrlId("Covered", 2001)}" name="Covered"` +
        ` parent="${artistUrlId(ARTIST)}" coverArt="${albumUrlId("Covered", 2001)}"` +
        ` songCount="2">`,
    );
    expect(xml).toContain('isDir="false"');
    expect(xml).not.toContain('isDir="0"');
  });

  it("answers an album with no tracks with a childless directory", async () => {
    const body = await browse("getMusicDirectory", { id: albumUrlId("Uncovered", 2005) });

    expect(body.status).toBe("ok");
    expect(body.directory?.parent).toBe(artistUrlId(ARTIST));
    expect(body.directory).not.toHaveProperty("child");
    expect(body.directory).not.toHaveProperty("coverArt");
    expect(body.directory).not.toHaveProperty("songCount");
  });
});

describe("getMusicDirectory of an id it cannot serve", () => {
  it("is error 10 when there is no id at all", async () => {
    const body = await browse("getMusicDirectory");

    expect(body.status).toBe("failed");
    expect(body.error).toEqual({ code: 10, message: "missing parameter: 'id'" });
  });

  it.each([
    ["a track", prefixedId("track", trackId(r2KeyOf("First Song")))],
    ["a playlist", prefixedId("playlist", playlistId("playlists/mine.m3u"))],
    ["an artist that is not there", prefixedId("artist", artistId("Nobody"))],
    ["an album that is not there", prefixedId("album", albumId("Nobody", "Nothing", 1999))],
    ["an unknown prefix", "xx-abcdefghijklmnopqrstuv"],
    ["no prefix", "abcdefghijklmnopqrstuv"],
    ["too few digits", "ar-abcdefgh"],
    ["a digit that is not base62", "al-abcdefghijklmnopqrst_v"],
    ["a number larger than 16 bytes", "ar-ZZZZZZZZZZZZZZZZZZZZZZ"],
  ])("is error 70 for %s", async (_case, id) => {
    const body = await browse("getMusicDirectory", { id });

    expect(body.status).toBe("failed");
    expect(body.error).toEqual({ code: 70, message: "Directory not found" });
  });
});
