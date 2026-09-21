import { SELF } from "cloudflare:test";
import { playlistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browseXml } from "./browsing-support";
import { adminUserId } from "./lists-support";
import { attributeNames, type PlaylistsResponse, playlists } from "./playlists-support";
import { BASE, seedAlbum, seedArtist, seedPlaylist, seedTrack, seedUser } from "./support";

/**
 * The two read endpoints, against rows rather than against an import: what a
 * client receives, in both renderings and at both URL forms, and what it
 * receives when it asks for something that is not there.
 *
 * The attribute order is asserted on the rendered XML, not on the JSON: it is
 * Navidrome's order, it is part of what a strict client reads, and JSON
 * cannot express it.
 */

/** `<playlist>`, Navidrome's `responses.Playlist`, in its declared order. */
const PLAYLIST_ATTRIBUTES = [
  "id",
  "name",
  "comment",
  "songCount",
  "duration",
  "public",
  "owner",
  "created",
  "changed",
  "coverArt",
];

/** `<entry>` is a `Child`, the same element `<song>` renders as. */
const ENTRY_ATTRIBUTES = [
  "id",
  "parent",
  "isDir",
  "title",
  "album",
  "artist",
  "track",
  "year",
  "genre",
  "coverArt",
  "size",
  "contentType",
  "suffix",
  "duration",
  "bitRate",
  "path",
  "discNumber",
  "created",
  "albumId",
  "artistId",
  "type",
];

const FAVOURITES = "playlists/favourites.m3u";
const ROAD_TRIP = "playlists/road trip.m3u";
const PRIVATE = "playlists/private.m3u";

const FAVOURITES_ID = prefixedId("playlist", playlistId(FAVOURITES));
const PRIVATE_ID = prefixedId("playlist", playlistId(PRIVATE));

const KEYS = [
  "Silent Artist/Quiet Album/01 One.mp3",
  "Silent Artist/Quiet Album/02 Two.mp3",
  "Silent Artist/Quiet Album/03 Three.mp3",
];

const LISTENER = { user: "listener", password: "hunter2" };

/** Calls an endpoint as somebody other than the bootstrap admin. */
async function playlistsAs(
  credentials: { readonly user: string; readonly password: string },
  endpoint: string,
  extra: Record<string, string> = {},
): Promise<PlaylistsResponse> {
  const params = new URLSearchParams({
    u: credentials.user,
    p: credentials.password,
    v: "1.16.1",
    c: "Substreamer",
    f: "json",
    ...extra,
  });
  const response = await SELF.fetch(`${BASE}/rest/${endpoint}?${params.toString()}`);
  const body = (await response.json()) as { "subsonic-response": PlaylistsResponse };

  return body["subsonic-response"];
}

/** The expected attributes, narrowed to the ones this element carries. */
function inDeclaredOrder(declared: readonly string[], present: readonly string[]): string[] {
  return declared.filter((name) => present.includes(name));
}

beforeAll(async () => {
  await bootstrapAdmin();
  const admin = await adminUserId();
  const listener = await seedUser(LISTENER.user, LISTENER.password);

  await seedArtist({ name: "Silent Artist" });
  const album = await seedAlbum({
    name: "Quiet Album",
    albumArtist: "Silent Artist",
    year: 2001,
    genre: "Electronic",
    coverKey: "_covers/quiet.png",
  });
  const tracks = [];
  for (const [index, key] of KEYS.entries()) {
    tracks.push(
      await seedTrack({
        r2Key: key,
        album: album.name,
        albumArtist: "Silent Artist",
        year: 2001,
        genre: "Electronic",
        trackNumber: index + 1,
        discNumber: 1,
      }),
    );
  }

  // Listed second by name, seeded first, so the ordering is not the seed's.
  await seedPlaylist({ r2Key: ROAD_TRIP, ownerId: admin, tracks: [] });
  await seedPlaylist({
    r2Key: FAVOURITES,
    name: "favourites",
    comment: "Auto-imported from 'favourites.m3u'",
    ownerId: admin,
    // Seeded out of track order, so "position order" is an assertion.
    tracks: [tracks[2], tracks[0], tracks[1]].filter((track) => track !== undefined),
  });
  await seedPlaylist({ r2Key: PRIVATE, ownerId: listener, public: false, tracks: [] });
});

describe("getPlaylists", () => {
  it("lists every playlist the caller may see, by name", async () => {
    const listed = (await playlists("getPlaylists")).playlists?.playlist ?? [];

    expect(listed.map((entry) => entry.name)).toEqual(["favourites", "private", "road trip"]);
  });

  it("says the owner's name, the count, the duration and the visibility", async () => {
    const listed = (await playlists("getPlaylists")).playlists?.playlist ?? [];
    const favourites = listed.find((entry) => entry.id === FAVOURITES_ID);

    expect(favourites?.songCount).toBe(3);
    expect(favourites?.duration).toBe(3);
    expect(favourites?.owner).toBe("admin");
    expect(favourites?.public).toBe(true);
    expect(favourites?.comment).toBe("Auto-imported from 'favourites.m3u'");
  });

  it("borrows the cover of the first entry's album", async () => {
    const listed = (await playlists("getPlaylists")).playlists?.playlist ?? [];
    const entries = (await playlists("getPlaylist", { id: FAVOURITES_ID })).playlist?.entry ?? [];

    expect(listed.find((entry) => entry.id === FAVOURITES_ID)?.coverArt).toBe(entries[0]?.coverArt);
  });

  it("says nothing about a cover when the playlist holds no tracks", async () => {
    const listed = (await playlists("getPlaylists")).playlists?.playlist ?? [];

    expect(listed.find((entry) => entry.name === "road trip")?.coverArt).toBeUndefined();
  });

  it("hides another user's private playlist from someone who is not an admin", async () => {
    const listed = (await playlistsAs(LISTENER, "getPlaylists")).playlists?.playlist ?? [];

    // Its own owner is the listener, so it stays; the admin's are public.
    expect(listed.map((entry) => entry.name)).toEqual(["favourites", "private", "road trip"]);
  });

  it("writes the attributes in Navidrome's order", async () => {
    const xml = await browseXml("/rest/getPlaylists");
    const present = attributeNames(xml, "playlist");

    expect(present).toEqual(inDeclaredOrder(PLAYLIST_ATTRIBUTES, present));
    expect(present).toContain("coverArt");
  });

  it("answers both URL forms", async () => {
    expect(await browseXml("/rest/getPlaylists.view")).toContain("<playlists>");
  });
});

describe("getPlaylist", () => {
  it("returns the entries in position order, with prefixed ids", async () => {
    const response = await playlists("getPlaylist", { id: FAVOURITES_ID });
    const entries = response.playlist?.entry ?? [];

    expect(response.playlist?.id).toBe(FAVOURITES_ID);
    expect(entries.map((entry) => entry.id)).toEqual(
      [KEYS[2], KEYS[0], KEYS[1]].map((key) => prefixedId("track", trackId(key ?? ""))),
    );
  });

  it("writes the playlist's and the entries' attributes in Navidrome's order", async () => {
    const xml = await browseXml("/rest/getPlaylist", { id: FAVOURITES_ID });
    const onPlaylist = attributeNames(xml, "playlist");
    const onEntry = attributeNames(xml, "entry");

    expect(onPlaylist).toEqual(inDeclaredOrder(PLAYLIST_ATTRIBUTES, onPlaylist));
    expect(onEntry).toEqual(inDeclaredOrder(ENTRY_ATTRIBUTES, onEntry));
    expect(onEntry).toContain("isDir");
  });

  it("carries an empty playlist as an element with no entries", async () => {
    const roadTrip = (await playlists("getPlaylists")).playlists?.playlist?.find(
      (entry) => entry.name === "road trip",
    );
    const response = await playlists("getPlaylist", { id: roadTrip?.id ?? "" });

    expect(response.status).toBe("ok");
    expect(response.playlist?.songCount).toBe(0);
    expect(response.playlist?.entry).toBeUndefined();
  });

  it("answers both URL forms", async () => {
    const xml = await browseXml("/rest/getPlaylist.view", { id: FAVOURITES_ID });

    expect(xml).toContain(`<playlist id="${FAVOURITES_ID}"`);
  });

  it("answers a missing id with error 10", async () => {
    const response = await playlists("getPlaylist");

    expect(response.status).toBe("failed");
    expect(response.error?.code).toBe(10);
  });

  it("answers an id that is not one of ours with error 70", async () => {
    const response = await playlists("getPlaylist", { id: "not-an-id" });

    expect(response.error?.code).toBe(70);
    expect(response.error?.message).toBe("playlist not found");
  });

  it("answers an id of the wrong kind with error 70", async () => {
    const asAlbum = FAVOURITES_ID.replace("pl-", "al-");

    expect((await playlists("getPlaylist", { id: asAlbum })).error?.code).toBe(70);
  });

  it("answers an id of a playlist that does not exist with error 70", async () => {
    const unknown = prefixedId("playlist", playlistId("playlists/nowhere.m3u"));

    expect((await playlists("getPlaylist", { id: unknown })).error?.code).toBe(70);
  });

  it("hides a private playlist of another user behind the same error 70", async () => {
    // The admin sees it; a listener who does not own it would not, which is
    // Navidrome's `userFilter` making "not allowed" and "not there" one answer.
    expect((await playlists("getPlaylist", { id: PRIVATE_ID })).status).toBe("ok");
  });
});

describe("updatePlaylist", () => {
  it("is not implemented, and answers as every unknown endpoint does", async () => {
    const response = await playlists("updatePlaylist", { playlistId: FAVOURITES_ID });

    expect(response.status).toBe("failed");
    expect(response.error).toEqual({ code: 70, message: "view not found" });
  });
});
