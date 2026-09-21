import { albumId, artistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browseXml } from "./browsing-support";
import { adminUserId, list, listAs } from "./lists-support";
import { seedAlbum, seedAnnotation, seedArtist, seedTrack, seedUser } from "./support";

/**
 * `getStarred2`: what the caller has starred, and only the caller.
 *
 * Clients treat this list as authoritative - an item missing from it is
 * unstarred locally - so the two things that matter are that it is complete
 * for whoever is asking and that it never carries anybody else's rows.
 */

const SEEDED = new Date(1_700_000_000_000);

function starredAt(minutes: number): Date {
  return new Date(SEEDED.getTime() + minutes * 60_000);
}

const ARTIST = "Corvid";
const OTHER_ARTIST = "Lamplight";
const ALBUM = "Rookery";
const TRACK_KEY = `${ARTIST}/${ALBUM}/01 Nest.mp3`;
const OTHER_TRACK_KEY = `${ARTIST}/${ALBUM}/02 Perch.mp3`;

const OTHER_USER = { user: "listener", password: "open-sesame" };

let admin = "";
let other = "";

beforeAll(async () => {
  await bootstrapAdmin();
  admin = await adminUserId();
  other = await seedUser(OTHER_USER.user, OTHER_USER.password);

  await seedArtist({ name: ARTIST });
  await seedArtist({ name: OTHER_ARTIST });
  await seedAlbum({ name: ALBUM, albumArtist: ARTIST, year: 2014, songCount: 2, coverKey: null });
  await seedTrack({ r2Key: TRACK_KEY, album: ALBUM, albumArtist: ARTIST, year: 2014 });
  await seedTrack({ r2Key: OTHER_TRACK_KEY, album: ALBUM, albumArtist: ARTIST, year: 2014 });
});

describe("getStarred2 with nothing starred", () => {
  it("answers with a valid, empty container", async () => {
    const body = await list("getStarred2");

    expect(body.status).toBe("ok");
    expect(body.starred2).toEqual({});
  });

  it.each(["/rest/getStarred2", "/rest/getStarred2.view"])(
    "answers on %s with a childless element",
    async (path) => {
      const xml = await browseXml(path);

      expect(xml).toContain("<starred2/>");
      expect(xml).not.toContain("<error");
    },
  );
});

describe("getStarred2 with stars", () => {
  beforeAll(async () => {
    await seedAnnotation({
      userId: admin,
      itemId: artistId(ARTIST),
      itemType: "artist",
      starredAt: starredAt(1),
    });
    await seedAnnotation({
      userId: admin,
      itemId: albumId(ARTIST, ALBUM, 2014),
      itemType: "album",
      starredAt: starredAt(2),
    });
    await seedAnnotation({
      userId: admin,
      itemId: trackId(TRACK_KEY),
      itemType: "track",
      starredAt: starredAt(3),
    });

    // Another account's stars, on items the admin has not starred, so a leak
    // shows up as an extra entry rather than as a duplicate.
    await seedAnnotation({
      userId: other,
      itemId: artistId(OTHER_ARTIST),
      itemType: "artist",
      starredAt: starredAt(4),
    });
    await seedAnnotation({
      userId: other,
      itemId: trackId(OTHER_TRACK_KEY),
      itemType: "track",
      starredAt: starredAt(5),
    });
  });

  it("returns the caller's artist, album and song", async () => {
    const starred = (await list("getStarred2")).starred2;

    expect(starred?.artist?.map((artist) => artist.name)).toEqual([ARTIST]);
    expect(starred?.album?.map((album) => album.name)).toEqual([ALBUM]);
    expect(starred?.song?.map((song) => song.title)).toEqual(["01 Nest"]);
  });

  it("gives every item its prefixed id", async () => {
    const starred = (await list("getStarred2")).starred2;

    expect(starred?.artist?.[0]?.id).toBe(prefixedId("artist", artistId(ARTIST)));
    expect(starred?.album?.[0]?.id).toBe(prefixedId("album", albumId(ARTIST, ALBUM, 2014)));
    expect(starred?.song?.[0]?.id).toBe(prefixedId("track", trackId(TRACK_KEY)));
  });

  it("does not carry another account's stars", async () => {
    const starred = (await list("getStarred2")).starred2;

    expect(starred?.artist?.map((artist) => artist.name)).not.toContain(OTHER_ARTIST);
    expect(starred?.song?.map((song) => song.title)).not.toContain("02 Perch");
  });

  it("gives the other account its own stars and nothing of the admin's", async () => {
    const starred = (await listAs(OTHER_USER, "getStarred2")).starred2;

    expect(starred?.artist?.map((artist) => artist.name)).toEqual([OTHER_ARTIST]);
    expect(starred?.song?.map((song) => song.title)).toEqual(["02 Perch"]);
    expect(starred?.album).toBeUndefined();
  });

  it("orders each kind most recently starred first", async () => {
    await seedAnnotation({
      userId: admin,
      itemId: trackId(OTHER_TRACK_KEY),
      itemType: "track",
      starredAt: starredAt(9),
    });

    const songs = (await list("getStarred2")).starred2?.song;

    expect(songs?.map((song) => song.title)).toEqual(["02 Perch", "01 Nest"]);
  });

  it("writes the children in Navidrome's order: artist, album, song", async () => {
    const xml = await browseXml("/rest/getStarred2");
    const order = ["<artist ", "<album ", "<song "].map((tag) => xml.indexOf(tag));

    expect(order.every((at) => at > 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it("accepts the one music folder and rejects any other", async () => {
    const theirs = await list("getStarred2", { musicFolderId: "7" });

    expect((await list("getStarred2", { musicFolderId: "1" })).status).toBe("ok");
    expect(theirs.error).toEqual({ code: 70, message: "Library 7 not found or not accessible" });
  });
});
