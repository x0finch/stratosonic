import { albumId, artistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { write, writeXml } from "./annotations-support";
import { bootstrapAdmin, browse } from "./browsing-support";
import { adminUserId } from "./lists-support";
import { seedAlbum, seedAnnotation, seedArtist, seedTrack, seedUser } from "./support";

/**
 * `setRating`: the caller rates an item, and sees it as `userRating` wherever
 * that item is browsed; 0 clears it. Each write is read back over HTTP.
 */

const ARTIST = "Cygnus";
const ALBUM = "Deneb";
const YEAR = 2016;
const TRACK_KEY = `${ARTIST}/${ALBUM}/01 Rift.mp3`;
// A track only the "leaves star and play data untouched" case uses, so its
// pre-seeded annotation never collides with a rating another case wrote.
const HALO_KEY = `${ARTIST}/${ALBUM}/02 Halo.mp3`;

const songId = prefixedId("track", trackId(TRACK_KEY));
const haloId = prefixedId("track", trackId(HALO_KEY));
const theAlbumId = prefixedId("album", albumId(ARTIST, ALBUM, YEAR));
const theArtistId = prefixedId("artist", artistId(ARTIST));

const OTHER_USER = { user: "rater", password: "open-sesame" };

let admin = "";

beforeAll(async () => {
  await bootstrapAdmin();
  admin = await adminUserId();
  await seedUser(OTHER_USER.user, OTHER_USER.password);

  await seedArtist({ name: ARTIST });
  await seedAlbum({ name: ALBUM, albumArtist: ARTIST, year: YEAR, songCount: 2 });
  await seedTrack({
    r2Key: TRACK_KEY,
    title: "Rift",
    album: ALBUM,
    albumArtist: ARTIST,
    year: YEAR,
  });
  await seedTrack({
    r2Key: HALO_KEY,
    title: "Halo",
    album: ALBUM,
    albumArtist: ARTIST,
    year: YEAR,
  });
  await seedAnnotation({
    userId: admin,
    itemId: trackId(HALO_KEY),
    itemType: "track",
    starredAt: new Date(1_700_000_000_000),
    playCount: 6,
    playDate: new Date(1_700_000_500_000),
  });
});

describe("rating an item", () => {
  it("shows a song's rating on getSong", async () => {
    const ok = await write("setRating", { id: songId, rating: "4" });
    expect(ok.status).toBe("ok");

    const song = (await browse("getSong", { id: songId })).song;
    expect(song?.userRating).toBe(4);

    await write("setRating", { id: songId, rating: "0" });
  });

  it("shows an album's rating on getAlbum", async () => {
    await write("setRating", { id: theAlbumId, rating: "5" });

    const album = (await browse("getAlbum", { id: theAlbumId })).album;
    expect(album?.userRating).toBe(5);

    await write("setRating", { id: theAlbumId, rating: "0" });
  });

  it("shows an artist's rating on getArtist", async () => {
    await write("setRating", { id: theArtistId, rating: "3" });

    const artist = (await browse("getArtist", { id: theArtistId })).artist;
    expect(artist?.userRating).toBe(3);

    await write("setRating", { id: theArtistId, rating: "0" });
  });

  it("clears a rating with 0, dropping the attribute", async () => {
    await write("setRating", { id: songId, rating: "3" });
    await write("setRating", { id: songId, rating: "0" });

    const song = (await browse("getSong", { id: songId })).song;
    expect(song?.userRating).toBeUndefined();
  });

  it("leaves the star and play data untouched", async () => {
    await write("setRating", { id: haloId, rating: "2" });

    const song = (await browse("getSong", { id: haloId })).song;
    expect(song?.userRating).toBe(2);
    expect(song?.starred).toBeTruthy();
    expect(song?.playCount).toBe(6);

    await write("setRating", { id: haloId, rating: "0" });
  });
});

describe("bad requests", () => {
  it("is error 0 for a rating above 5", async () => {
    const body = await write("setRating", { id: songId, rating: "6" });
    expect(body.error?.code).toBe(0);
  });

  it("is error 0 for a negative rating", async () => {
    const body = await write("setRating", { id: songId, rating: "-1" });
    expect(body.error?.code).toBe(0);
  });

  it("is error 0 for a non-integer rating", async () => {
    const body = await write("setRating", { id: songId, rating: "good" });
    expect(body.error?.code).toBe(0);
  });

  it("is error 10 when id or rating is missing", async () => {
    expect((await write("setRating", { rating: "4" })).error?.code).toBe(10);
    expect((await write("setRating", { id: songId })).error?.code).toBe(10);
  });

  it("is error 10 for a missing rating even when the id is malformed", async () => {
    const body = await write("setRating", { id: "garbage" });
    expect(body.error?.code).toBe(10);
  });

  it("is error 70 for an id that names nothing", async () => {
    const body = await write("setRating", {
      id: prefixedId("track", trackId("Ghost/None/x.mp3")),
      rating: "4",
    });
    expect(body.error?.code).toBe(70);
  });
});

/**
 * How the rating itself is read: Go's `strconv.ParseInt`, which Navidrome's
 * `p.Int` bottoms out in, takes an optional sign and nothing else — no
 * decimal point, no surrounding space.
 */
describe("reading the rating", () => {
  it("is error 0 for a rating written as a decimal", async () => {
    const body = await write("setRating", { id: songId, rating: "4.0" });
    expect(body.error?.code).toBe(0);
  });

  it("is error 0 for a rating with a leading space", async () => {
    const body = await write("setRating", { id: songId, rating: " 4" });
    expect(body.error?.code).toBe(0);
  });

  it("takes a signed rating, as ParseInt does", async () => {
    const ok = await write("setRating", { id: songId, rating: "+4" });
    expect(ok.status).toBe("ok");

    const song = (await browse("getSong", { id: songId })).song;
    expect(song?.userRating).toBe(4);

    await write("setRating", { id: songId, rating: "0" });
  });
});

describe("isolation between accounts", () => {
  it("rates only for the caller", async () => {
    await write("setRating", { id: songId, rating: "0" });
    const ok = await write("setRating", { id: songId, rating: "5" }, OTHER_USER);
    expect(ok.status).toBe("ok");

    const song = (await browse("getSong", { id: songId })).song;
    expect(song?.userRating).toBeUndefined();

    await write("setRating", { id: songId, rating: "0" }, OTHER_USER);
  });
});

describe("envelope", () => {
  it("answers an empty ok in XML", async () => {
    const xml = await writeXml("setRating", { id: songId, rating: "4" });

    expect(xml).toContain('status="ok"');
    expect(xml).not.toContain("<error");

    await write("setRating", { id: songId, rating: "0" });
  });
});
