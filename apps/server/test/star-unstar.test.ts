import { albumId, artistId, playlistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { write, writeXml } from "./annotations-support";
import { bootstrapAdmin, browse } from "./browsing-support";
import { adminUserId, list, listAs } from "./lists-support";
import {
  seedAlbum,
  seedAnnotation,
  seedArtist,
  seedPlaylist,
  seedTrack,
  seedUser,
} from "./support";

/**
 * `star` and `unstar`: the caller taps a heart and it sticks.
 *
 * Each write is exercised over HTTP and then read back over HTTP — `star`,
 * then `getStarred2` and `getSong` — so what is asserted is the behaviour a
 * client sees, not a row. The two things that matter to a client are that a
 * star is complete for whoever set it and never carries into another account.
 */

const ARTIST = "Vega";
const ALBUM = "Lyra";
const YEAR = 2018;
const ONE_KEY = `${ARTIST}/${ALBUM}/01 One.mp3`;
const TWO_KEY = `${ARTIST}/${ALBUM}/02 Two.mp3`;

const songId = prefixedId("track", trackId(ONE_KEY));
const otherSongId = prefixedId("track", trackId(TWO_KEY));
const theAlbumId = prefixedId("album", albumId(ARTIST, ALBUM, YEAR));
const theArtistId = prefixedId("artist", artistId(ARTIST));

const PLAYLIST_KEY = "playlists/favourites.m3u";
const thePlaylistId = prefixedId("playlist", playlistId(PLAYLIST_KEY));

const OTHER_USER = { user: "listener", password: "open-sesame" };

let other = "";

beforeAll(async () => {
  await bootstrapAdmin();
  await adminUserId();
  other = await seedUser(OTHER_USER.user, OTHER_USER.password);

  await seedArtist({ name: ARTIST });
  await seedAlbum({ name: ALBUM, albumArtist: ARTIST, year: YEAR, songCount: 2 });
  await seedTrack({ r2Key: ONE_KEY, title: "One", album: ALBUM, albumArtist: ARTIST, year: YEAR });
  await seedTrack({ r2Key: TWO_KEY, title: "Two", album: ALBUM, albumArtist: ARTIST, year: YEAR });
  await seedPlaylist({ r2Key: PLAYLIST_KEY, name: "Favourites" });
});

describe("starring a song", () => {
  it("adds it to getStarred2 and marks it on getSong", async () => {
    const ok = await write("star", { id: songId });
    expect(ok.status).toBe("ok");
    expect(ok.error).toBeUndefined();

    const starred = (await list("getStarred2")).starred2;
    expect(starred?.song?.map((song) => song.title)).toContain("One");

    const song = (await browse("getSong", { id: songId })).song;
    expect(song?.starred).toBeTruthy();
  });

  it("removes it again on unstar", async () => {
    await write("star", { id: songId });
    await write("unstar", { id: songId });

    const starred = (await list("getStarred2")).starred2;
    expect(starred?.song?.map((song) => song.title) ?? []).not.toContain("One");

    const song = (await browse("getSong", { id: songId })).song;
    expect(song?.starred).toBeUndefined();
  });
});

describe("starring an album and an artist in one call", () => {
  it("stars both", async () => {
    await write("star", { albumId: theAlbumId, artistId: theArtistId });

    const starred = (await list("getStarred2")).starred2;
    expect(starred?.album?.map((album) => album.name)).toContain(ALBUM);
    expect(starred?.artist?.map((artist) => artist.name)).toContain(ARTIST);

    await write("unstar", { albumId: theAlbumId, artistId: theArtistId });
  });
});

describe("idempotence and ordering", () => {
  it("keeps the original starred instant when a star is repeated", async () => {
    await write("unstar", { id: songId });
    await write("star", { id: songId });

    const firstStar = (await list("getStarred2")).starred2?.song?.find(
      (song) => song.title === "One",
    )?.starred;

    await write("star", { id: songId });
    const secondStar = (await list("getStarred2")).starred2?.song?.find(
      (song) => song.title === "One",
    )?.starred;

    expect(secondStar).toBe(firstStar);

    await write("unstar", { id: songId });
  });

  it("orders getStarred2 most recently starred first", async () => {
    await write("unstar", { id: songId });
    await write("unstar", { id: otherSongId });

    await write("star", { id: songId });
    await write("star", { id: otherSongId });

    const titles = (await list("getStarred2")).starred2?.song?.map((song) => song.title);
    expect(titles).toEqual(["Two", "One"]);

    await write("unstar", { id: songId });
    await write("unstar", { id: otherSongId });
  });
});

describe("starring a playlist", () => {
  // Navidrome's setStar stars playlists too. Nothing reads the star back:
  // its <playlist> element carries no `starred` attribute, so the row is
  // written and the ok envelope is all a client sees.
  it("answers an empty ok", async () => {
    const ok = await write("star", { id: thePlaylistId });

    expect(ok.status).toBe("ok");
    expect(ok.error).toBeUndefined();

    await write("unstar", { id: thePlaylistId });
  });

  it("is error 70 for a playlist id that names nothing", async () => {
    const unknown = prefixedId("playlist", playlistId("playlists/nowhere.m3u"));
    const body = await write("star", { id: unknown });

    expect(body.error).toEqual({ code: 70, message: "The requested data was not found" });
  });
});

describe("isolation between accounts", () => {
  it("writes only the caller's rows", async () => {
    await seedAnnotation({ userId: other, itemId: trackId(TWO_KEY), itemType: "track" });

    await write("star", { id: songId });

    // The admin sees only its own star, not the other account's.
    const mine = (await list("getStarred2")).starred2?.song?.map((song) => song.title);
    expect(mine).toEqual(["One"]);

    // The other account still sees only its own.
    const theirs = (await listAs(OTHER_USER, "getStarred2")).starred2?.song?.map(
      (song) => song.title,
    );
    expect(theirs).toEqual(["Two"]);

    await write("unstar", { id: songId });
  });
});

describe("bad requests", () => {
  it("is error 10 with none of id, albumId or artistId", async () => {
    const body = await write("star", {});
    expect(body.error?.code).toBe(10);
  });

  it("is error 70 for an id that names nothing", async () => {
    const body = await write("star", { id: prefixedId("track", trackId("Ghost/Absent/x.mp3")) });
    expect(body.error).toEqual({ code: 70, message: "The requested data was not found" });
  });

  it("is error 70 for a malformed id", async () => {
    const body = await write("star", { id: "not-an-id" });
    expect(body.error?.code).toBe(70);
  });

  // The cap is counted before the ids are parsed, so these need not name rows.
  it("is error 0 for more ids than one request may name", async () => {
    const body = await write("star", { id: Array.from({ length: 1200 }, () => "x") });

    expect(body.error).toEqual({
      code: 0,
      message: "too many ids: 1200, at most 1000 per request",
    });
  });
});

describe("envelope", () => {
  it("answers an empty ok in XML", async () => {
    await write("star", { id: songId });
    const xml = await writeXml("star", { id: songId });

    expect(xml).toContain('status="ok"');
    expect(xml).not.toContain("<error");

    await write("unstar", { id: songId });
  });
});
