import { albumId, artistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browse, browseXml } from "./browsing-support";
import { seedAlbum, seedArtist, seedTrack } from "./support";

/**
 * What the browsing endpoints say when the `id` is not one they can serve.
 *
 * The library here holds one of everything, so a "not found" is about the id
 * the client sent and not about an empty database.
 */

const ARTIST = "Present Artist";
const ALBUM = { name: "Present Album", year: 2012 };
const R2_KEY = `${ARTIST}/${ALBUM.name}/01 Present Track.mp3`;

const REAL = {
  artist: prefixedId("artist", artistId(ARTIST)),
  album: prefixedId("album", albumId(ARTIST, ALBUM.name, ALBUM.year)),
  track: prefixedId("track", trackId(R2_KEY)),
};

/** Well-formed ids of things that are not in the library. */
const UNKNOWN = {
  artist: prefixedId("artist", artistId("Absent Artist")),
  album: prefixedId("album", albumId("Absent Artist", "Absent Album", 1990)),
  track: prefixedId("track", trackId("Absent Artist/Absent Album/01 Gone.mp3")),
};

beforeAll(async () => {
  await bootstrapAdmin();
  await seedArtist({ name: ARTIST });
  await seedAlbum({ name: ALBUM.name, albumArtist: ARTIST, year: ALBUM.year, songCount: 1 });
  await seedTrack({ r2Key: R2_KEY, album: ALBUM.name, albumArtist: ARTIST, year: ALBUM.year });
});

describe("an id that is missing", () => {
  it.each(["getArtist", "getAlbum", "getSong"])("is error 10 on %s", async (endpoint) => {
    const body = await browse(endpoint);

    expect(body.status).toBe("failed");
    expect(body.error?.code).toBe(10);
    expect(body.error?.message).toBe("missing parameter: 'id'");
  });
});

describe("an id that names nothing", () => {
  it.each([
    ["getArtist", UNKNOWN.artist, "Artist not found"],
    ["getAlbum", UNKNOWN.album, "Album not found"],
    ["getSong", UNKNOWN.track, "Song not found"],
  ])("is error 70 on %s", async (endpoint, id, message) => {
    const body = await browse(endpoint, { id });

    expect(body.status).toBe("failed");
    expect(body.error).toEqual({ code: 70, message });
  });
});

describe("an id of the wrong kind", () => {
  it.each([
    ["getArtist", REAL.track],
    ["getArtist", REAL.album],
    ["getAlbum", REAL.artist],
    ["getAlbum", REAL.track],
    ["getSong", REAL.artist],
    ["getSong", REAL.album],
  ])("is error 70 on %s, even though the id names something real", async (endpoint, id) => {
    const body = await browse(endpoint, { id });

    expect(body.status).toBe("failed");
    expect(body.error?.code).toBe(70);
  });
});

describe("an id that could not have been minted here", () => {
  it.each([
    ["no prefix", "abcdefghijklmnopqrstuv"],
    ["an unknown prefix", "xx-abcdefghijklmnopqrstuv"],
    ["too few digits", "ar-abcdefgh"],
    ["a digit that is not base62", "ar-abcdefghijklmnopqrst_v"],
    ["a number larger than 16 bytes", "ar-ZZZZZZZZZZZZZZZZZZZZZZ"],
    ["a playlist id", `pl-${artistId(ARTIST)}`],
  ])("is error 70: %s", async (_case, id) => {
    const body = await browse("getArtist", { id });

    expect(body.status).toBe("failed");
    expect(body.error?.code).toBe(70);
  });
});

describe("a failure in XML", () => {
  it("comes back as an envelope a parser understands", async () => {
    const xml = await browseXml("/rest/getAlbum", { id: UNKNOWN.album });

    expect(xml).toContain('status="failed"');
    expect(xml).toContain('<error code="70" message="Album not found"/>');
  });
});
