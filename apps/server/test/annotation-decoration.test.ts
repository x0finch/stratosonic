import { SELF } from "cloudflare:test";
import { albumId, artistId, playlistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { type BrowsingResponse, bootstrapAdmin, browse } from "./browsing-support";
import { adminUserId, list } from "./lists-support";
import { playlists } from "./playlists-support";
import { search } from "./search-support";
import {
  BASE,
  seedAlbum,
  seedAnnotation,
  seedArtist,
  seedPlaylist,
  seedTrack,
  seedUser,
} from "./support";

/**
 * The caller's annotation, decorated onto every item they read.
 *
 * This is the seam `star`, `setRating` and `scrobble` light up; here it is
 * exercised by seeding annotation rows directly and asserting that each read —
 * browsing, lists, playlist entries, folder children, search — carries
 * `starred`, `userRating`, `playCount` and `played` on the annotated item, that
 * an unannotated item carries none of them, and that a second account sees none
 * of the first's.
 */

const ARTIST = "Aurora";
const ALBUM = "Nightside";
const YEAR = 2020;
const TRACK_KEY = `${ARTIST}/${ALBUM}/01 Polar.mp3`;
const OTHER_TRACK_KEY = `${ARTIST}/${ALBUM}/02 Second.mp3`;
const PLAYLIST_KEY = "playlists/mix.m3u";

const SEED = new Date(1_700_000_000_000);
const at = (minutes: number) => new Date(SEED.getTime() + minutes * 60_000);

const TRACK_STARRED = at(1);
const TRACK_PLAYED = at(5);
const ALBUM_STARRED = at(2);
const ALBUM_PLAYED = at(6);
const ARTIST_STARRED = at(3);

const OTHER_USER = { user: "listener", password: "open-sesame" };

let admin = "";

/** Calls an endpoint as another account, to prove whose annotation shows. */
async function browseAs(
  credentials: { user: string; password: string },
  endpoint: string,
  extra: Record<string, string> = {},
): Promise<BrowsingResponse> {
  const params = new URLSearchParams({
    u: credentials.user,
    p: credentials.password,
    v: "1.16.1",
    c: "Substreamer",
    f: "json",
    ...extra,
  });
  const response = await SELF.fetch(`${BASE}/rest/${endpoint}?${params.toString()}`);
  const body = (await response.json()) as { "subsonic-response": BrowsingResponse };

  return body["subsonic-response"];
}

beforeAll(async () => {
  await bootstrapAdmin();
  admin = await adminUserId();
  await seedUser(OTHER_USER.user, OTHER_USER.password);

  await seedArtist({ name: ARTIST });
  const album = await seedAlbum({
    name: ALBUM,
    albumArtist: ARTIST,
    year: YEAR,
    songCount: 2,
    coverKey: null,
  });
  const track = await seedTrack({
    r2Key: TRACK_KEY,
    title: "Polar",
    album: ALBUM,
    albumArtist: ARTIST,
    year: YEAR,
  });
  const other = await seedTrack({
    r2Key: OTHER_TRACK_KEY,
    title: "Second",
    album: ALBUM,
    albumArtist: ARTIST,
    year: YEAR,
  });
  await seedPlaylist({ r2Key: PLAYLIST_KEY, name: "Mix", ownerId: admin, tracks: [track, other] });

  await seedAnnotation({
    userId: admin,
    itemId: trackId(TRACK_KEY),
    itemType: "track",
    starredAt: TRACK_STARRED,
    rating: 4,
    playCount: 3,
    playDate: TRACK_PLAYED,
  });
  await seedAnnotation({
    userId: admin,
    itemId: album.id,
    itemType: "album",
    starredAt: ALBUM_STARRED,
    rating: 5,
    playCount: 7,
    playDate: ALBUM_PLAYED,
  });
  await seedAnnotation({
    userId: admin,
    itemId: artistId(ARTIST),
    itemType: "artist",
    starredAt: ARTIST_STARRED,
    rating: 2,
  });
});

describe("a song the caller has annotated", () => {
  it("carries starred, userRating, playCount and played on getSong", async () => {
    const song = (await browse("getSong", { id: prefixedId("track", trackId(TRACK_KEY)) })).song;

    expect(song?.starred).toBe(TRACK_STARRED.toISOString());
    expect(song?.userRating).toBe(4);
    expect(song?.playCount).toBe(3);
    expect(song?.played).toBe(TRACK_PLAYED.toISOString());
  });

  it("carries none of them on a song the caller has not annotated", async () => {
    const song = (await browse("getSong", { id: prefixedId("track", trackId(OTHER_TRACK_KEY)) }))
      .song;

    expect(song?.starred).toBeUndefined();
    expect(song?.userRating).toBeUndefined();
    expect(song?.playCount).toBeUndefined();
    expect(song?.played).toBeUndefined();
  });
});

describe("an album the caller has annotated", () => {
  it("carries the album's annotation and its tracks' on getAlbum", async () => {
    const album = (
      await browse("getAlbum", { id: prefixedId("album", albumId(ARTIST, ALBUM, YEAR)) })
    ).album;

    expect(album?.starred).toBe(ALBUM_STARRED.toISOString());
    expect(album?.userRating).toBe(5);
    expect(album?.playCount).toBe(7);
    expect(album?.played).toBe(ALBUM_PLAYED.toISOString());

    const polar = album?.song?.find((song) => song.title === "Polar");
    expect(polar?.userRating).toBe(4);
    const second = album?.song?.find((song) => song.title === "Second");
    expect(second?.userRating).toBeUndefined();
  });
});

describe("an artist the caller has annotated", () => {
  it("carries starred and userRating, but no play data", async () => {
    const artist = (await browse("getArtist", { id: prefixedId("artist", artistId(ARTIST)) }))
      .artist;

    expect(artist?.starred).toBe(ARTIST_STARRED.toISOString());
    expect(artist?.userRating).toBe(2);
    // The artist's album, listed under it, carries its own annotation too.
    expect(artist?.album?.[0]?.userRating).toBe(5);
  });
});

describe("the lists", () => {
  it("decorates the album on getAlbumList2", async () => {
    const albums = (await list("getAlbumList2", { type: "newest" })).albumList2?.album;
    const nightside = albums?.find((album) => album.name === ALBUM);

    expect(nightside?.userRating).toBe(5);
    expect(nightside?.playCount).toBe(7);
  });

  it("decorates the song on getRandomSongs", async () => {
    const songs = (await list("getRandomSongs", { size: "50" })).randomSongs?.song;
    const polar = songs?.find((song) => song.title === "Polar");

    expect(polar?.userRating).toBe(4);
    expect(polar?.played).toBe(TRACK_PLAYED.toISOString());
  });

  it("adds rating and play data to getStarred2, alongside starred", async () => {
    const starred = (await list("getStarred2")).starred2;

    expect(starred?.song?.[0]?.userRating).toBe(4);
    expect(starred?.song?.[0]?.playCount).toBe(3);
    expect(starred?.album?.[0]?.userRating).toBe(5);
    expect(starred?.artist?.[0]?.userRating).toBe(2);
  });
});

describe("playlist entries and folder children", () => {
  it("decorates a playlist's entries", async () => {
    const entries = (
      await playlists("getPlaylist", { id: prefixedId("playlist", playlistId(PLAYLIST_KEY)) })
    ).playlist?.entry;
    const polar = entries?.find((song) => song.title === "Polar");

    expect(polar?.userRating).toBe(4);
    expect(polar?.playCount).toBe(3);
  });

  it("decorates an album directory's track children", async () => {
    const directory = (
      await browse("getMusicDirectory", { id: prefixedId("album", albumId(ARTIST, ALBUM, YEAR)) })
    ).directory;
    const polar = directory?.child?.find((child) => child.title === "Polar");

    expect(polar?.userRating).toBe(4);
  });

  it("decorates an artist directory's album children", async () => {
    const directory = (
      await browse("getMusicDirectory", { id: prefixedId("artist", artistId(ARTIST)) })
    ).directory;
    const nightside = directory?.child?.find((child) => child.name === ALBUM);

    expect(nightside?.userRating).toBe(5);
  });
});

describe("search results", () => {
  it("decorates the artist, album and song a search returns", async () => {
    const result = (await search("search3", { query: "" })).searchResult3;

    expect(result?.artist?.[0]?.userRating).toBe(2);
    expect(result?.album?.[0]?.userRating).toBe(5);
    const polar = result?.song?.find((song) => song.title === "Polar");
    expect(polar?.userRating).toBe(4);
  });
});

describe("isolation between accounts", () => {
  it("shows a second account none of the first's annotation", async () => {
    const song = (
      await browseAs(OTHER_USER, "getSong", {
        id: prefixedId("track", trackId(TRACK_KEY)),
      })
    ).song;

    expect(song?.starred).toBeUndefined();
    expect(song?.userRating).toBeUndefined();
    expect(song?.playCount).toBeUndefined();
  });
});
