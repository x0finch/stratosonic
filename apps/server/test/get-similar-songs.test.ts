import { SELF } from "cloudflare:test";
import { albumId, artistId, prefixedId, type Track, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browseXml } from "./browsing-support";
import { type InfoResponse, info, infoCounting, infoPost, titles } from "./info-support";
import { adminUserId } from "./lists-support";
import {
  BASE,
  seedAlbum,
  seedAnnotation,
  seedArtist,
  seedFixtureLibrary,
  seedPlaylist,
  seedTrack,
  seedUser,
} from "./support";

/**
 * `getSimilarSongs` and `getSimilarSongs2` against the seeded fixture library,
 * plus two small artists of its own.
 *
 * With only Navidrome's local agent, a song is similar to the songs that share
 * its genre, and an artist's "top songs" are the caller's starred and
 * five-star tracks of it (core/agents/local_agent.go); the provider mixes the
 * two per kind of id (core/external/provider_similarsongs.go). The fixtures
 * give two genres — Electronic on Quiet Album, Ambient on Mute Ensemble's two
 * albums — and a track with none. The additions:
 *
 * - `Echo`, one track tagged `ELECTRONIC`, which shares Quiet Album's genre
 *   in another case.
 * - `Chorus`, three tracks with no genre, which the admin has starred (Alpha),
 *   rated five (Beta) and rated four (Gamma): the top songs are the first two.
 */

const SILENT_TRACK = "Silent Artist/Quiet Album/01 Silent Track.mp3";
const HUSHED = "Silent Artist/Quiet Album/02 Hushed Interlude.flac";
const FRONT = "Mute Ensemble/Faststart Sessions/01 Front Loaded.m4a";
const TAIL = "Mute Ensemble/Trailing Sessions/01 Tail Loaded.m4a";
const UNTAGGED = "Fallback Artist/Fallback Album/01 Untagged.mp3";
const ECHO = "Echo/Lower/01 Shout.mp3";
const ALPHA = "Chorus/Voices/01 Alpha.mp3";
const BETA = "Chorus/Voices/02 Beta.mp3";
const GAMMA = "Chorus/Voices/03 Gamma.mp3";

const LISTENER = { user: "listener", password: "hunter2" };

const song = (key: string) => prefixedId("track", trackId(key));
const QUIET = prefixedId("album", albumId("Silent Artist", "Quiet Album", 2001));
const FALLBACK_ALBUM = prefixedId("album", albumId("Fallback Artist", "Fallback Album", null));
const MUTE = prefixedId("artist", artistId("Mute Ensemble"));
const FALLBACK_ARTIST = prefixedId("artist", artistId("Fallback Artist"));
const CHORUS = prefixedId("artist", artistId("Chorus"));

let publicPlaylist = "";
let privatePlaylist = "";

/** The titles of the mix, sorted, for the cases whose order is random. */
async function mixOf(id: string, extra: Record<string, string> = {}): Promise<string[]> {
  const body = await info("getSimilarSongs", { id, ...extra });
  expect(body.status).toBe("ok");

  return titles(body.similarSongs?.song).sort();
}

beforeAll(async () => {
  await bootstrapAdmin();
  const admin = await adminUserId();
  const library = await seedFixtureLibrary();
  const byKey = new Map<string, Track>(library.tracks.map((track) => [track.r2Key, track]));
  const tracksOf = (...keys: string[]) => keys.map((key) => byKey.get(key) as Track);

  await seedArtist({ name: "Echo" });
  await seedAlbum({ name: "Lower", albumArtist: "Echo", genre: "ELECTRONIC", songCount: 1 });
  await seedTrack({ r2Key: ECHO, title: "Shout", genre: "ELECTRONIC" });

  await seedArtist({ name: "Chorus" });
  await seedAlbum({ name: "Voices", albumArtist: "Chorus", songCount: 3 });
  for (const [key, title] of [
    [ALPHA, "Alpha"],
    [BETA, "Beta"],
    [GAMMA, "Gamma"],
  ] as const) {
    await seedTrack({ r2Key: key, title });
  }
  await seedAnnotation({ userId: admin, itemId: trackId(ALPHA), itemType: "track", playCount: 1 });
  await seedAnnotation({
    userId: admin,
    itemId: trackId(BETA),
    itemType: "track",
    starred: false,
    rating: 5,
    playCount: 7,
  });
  await seedAnnotation({
    userId: admin,
    itemId: trackId(GAMMA),
    itemType: "track",
    starred: false,
    rating: 4,
    playCount: 9,
  });

  const owner = await seedUser("owner", "secret");
  await seedUser(LISTENER.user, LISTENER.password);
  const shared = await seedPlaylist({
    r2Key: "playlists/shared.m3u",
    ownerId: owner,
    tracks: tracksOf(SILENT_TRACK, SILENT_TRACK, FRONT),
  });
  const hidden = await seedPlaylist({
    r2Key: "playlists/hidden.m3u",
    ownerId: owner,
    public: false,
    tracks: tracksOf(UNTAGGED),
  });
  publicPlaylist = prefixedId("playlist", shared.id);
  privatePlaylist = prefixedId("playlist", hidden.id);
});

describe.each([
  ["getSimilarSongs", "similarSongs"],
  ["getSimilarSongs2", "similarSongs2"],
] as const)("%s", (endpoint, element) => {
  it.each([`/rest/${endpoint}`, `/rest/${endpoint}.view`])("answers XML on %s", async (path) => {
    const xml = await browseXml(path, { id: song(SILENT_TRACK), count: "1" });

    expect(xml).toContain('status="ok"');
    expect(xml).toMatch(new RegExp(`<${element}><song id="tr-[^"]+" parent="al-`));
    expect(xml).toContain('isDir="false"');
    expect(xml).toContain(`</${element}>`);
  });

  it("answers JSON under its own element name", async () => {
    const body = await info(endpoint, { id: song(SILENT_TRACK) });

    expect(titles(body[element]?.song).sort()).toEqual(["Hushed Interlude", "Shout"]);
  });

  it("answers a form POST", async () => {
    const xml = await infoPost(`/rest/${endpoint}`, { id: song(HUSHED) });

    expect(xml).toContain('status="ok"');
    expect(xml).toContain('title="Silent Track"');
  });

  it("answers an empty element when nothing is similar", async () => {
    const body = await info(endpoint, { id: song(UNTAGGED) });

    expect(body[element]).toEqual({});
    expect(await browseXml(`/rest/${endpoint}`, { id: song(UNTAGGED) })).toContain(`<${element}/>`);
  });

  it("answers error 10 without an id", async () => {
    const body = await info(endpoint, { count: "5" });

    expect(body.error).toEqual({ code: 10, message: "missing parameter: 'id'" });
  });

  it.each([
    ["a song that does not exist", () => song("Nobody/None/01.mp3")],
    ["an album that does not exist", () => prefixedId("album", albumId("Nobody", "None", null))],
    ["an artist that does not exist", () => prefixedId("artist", artistId("Nobody"))],
    ["a malformed id", () => "tr-nope"],
  ])("answers error 70 for %s", async (_label, id) => {
    const body = await info(endpoint, { id: id() });

    expect(body.status).toBe("failed");
    expect(body.error).toEqual({ code: 70, message: "data not found" });
  });
});

describe("getSimilarSongs for a song", () => {
  it("answers the songs sharing its genre, in any case, without the song itself", async () => {
    expect(await mixOf(song(SILENT_TRACK))).toEqual(["Hushed Interlude", "Shout"]);
    expect(await mixOf(song(FRONT))).toEqual(["Tail Loaded"]);
    expect(await mixOf(song(TAIL))).toEqual(["Front Loaded"]);
  });

  it("tops the mix up with the caller's top songs of the song's artist", async () => {
    // Gamma has no genre, so its own sample is empty; its artist's top songs
    // are what the caller starred (Alpha) or rated five (Beta), not Gamma.
    expect(await mixOf(song(GAMMA))).toEqual(["Alpha", "Beta"]);
  });

  it("can draw the song itself back in from those top songs, as Navidrome does", async () => {
    expect(await mixOf(song(ALPHA))).toEqual(["Alpha", "Beta"]);
  });

  it("keeps the genre sample ahead of the top-up", async () => {
    const body = await info("getSimilarSongs", { id: song(SILENT_TRACK), count: "1" });

    expect(titles(body.similarSongs?.song)).toHaveLength(1);
    expect(["Hushed Interlude", "Shout"]).toContain(titles(body.similarSongs?.song)[0]);
  });

  it("gives nobody else's top songs to another caller", async () => {
    const params = new URLSearchParams({
      u: LISTENER.user,
      p: LISTENER.password,
      v: "1.16.1",
      c: "Substreamer",
      f: "json",
      id: song(GAMMA),
    });
    const response = await SELF.fetch(`${BASE}/rest/getSimilarSongs?${params}`);
    const body = (await response.json()) as { "subsonic-response": InfoResponse };

    expect(body["subsonic-response"].similarSongs).toEqual({});
  });
});

describe("getSimilarSongs for an artist", () => {
  it("draws its top songs first, then tops up from its own tracks", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const body = await info("getSimilarSongs", { id: CHORUS });
      const mix = titles(body.similarSongs?.song);

      // The top songs come in a weighted random order, but always first; the
      // seeds share no genre, so the seeds themselves fill the rest.
      expect(mix.slice(0, 2).sort()).toEqual(["Alpha", "Beta"]);
      expect(mix[2]).toBe("Gamma");
    }
  });

  it("stops at count, taking from the top songs", async () => {
    const body = await info("getSimilarSongs", { id: CHORUS, count: "1" });

    expect(["Alpha", "Beta"]).toContain(titles(body.similarSongs?.song)[0]);
    expect(titles(body.similarSongs?.song)).toHaveLength(1);
  });

  it("mixes the songs sharing its tracks' genres", async () => {
    expect(await mixOf(MUTE)).toEqual(["Front Loaded", "Tail Loaded"]);
  });

  it("falls back to its own tracks when they share no genre", async () => {
    expect(await mixOf(FALLBACK_ARTIST)).toEqual(["01 Untagged"]);
  });
});

describe("getSimilarSongs for an album", () => {
  it("mixes the songs sharing its tracks' genres, its own included", async () => {
    // Each track is in the other's sample, as each seed's is in Navidrome.
    expect(await mixOf(QUIET)).toEqual(["Hushed Interlude", "Shout", "Silent Track"]);
  });

  it("falls back to its own tracks when they share no genre", async () => {
    expect(await mixOf(FALLBACK_ALBUM)).toEqual(["01 Untagged"]);
  });

  it("stops at count", async () => {
    expect(await mixOf(QUIET, { count: "2" })).toHaveLength(2);
  });
});

describe("getSimilarSongs for a playlist", () => {
  it("mixes the songs sharing its distinct tracks' genres", async () => {
    // Silent Track twice and Front Loaded: seeds of two genres, one each.
    expect(await mixOf(publicPlaylist)).toEqual(["Hushed Interlude", "Shout", "Tail Loaded"]);
  });

  it("answers a playlist the caller may not see as not found", async () => {
    const params = new URLSearchParams({
      u: LISTENER.user,
      p: LISTENER.password,
      v: "1.16.1",
      c: "Substreamer",
      f: "json",
      id: privatePlaylist,
    });
    const response = await SELF.fetch(`${BASE}/rest/getSimilarSongs?${params}`);
    const body = (await response.json()) as { "subsonic-response": InfoResponse };

    expect(body["subsonic-response"].error).toEqual({ code: 70, message: "data not found" });
  });

  it("lets an admin see every playlist, as Navidrome's userFilter does", async () => {
    expect(await mixOf(privatePlaylist)).toEqual(["01 Untagged"]);
  });
});

describe("getSimilarSongs count", () => {
  it.each(["0", "-3"])("answers no songs for count=%s, before looking the id up", async (count) => {
    const unknown = await info("getSimilarSongs", { id: song("Nobody/None/01.mp3"), count });

    expect(unknown.status).toBe("ok");
    expect(unknown.similarSongs).toEqual({});
  });

  it("reads a count it cannot parse as the default", async () => {
    expect(await mixOf(QUIET, { count: "lots" })).toHaveLength(3);
  });
});

describe("what getSimilarSongs costs", () => {
  it.each([
    ["a song", () => song(SILENT_TRACK), 2],
    ["an artist", () => CHORUS, 3],
    ["an album", () => QUIET, 3],
    ["a playlist", () => publicPlaylist, 3],
  ])("runs at most two statements beyond authentication for %s", async (_label, id, songs) => {
    const counted = await infoCounting("getSimilarSongs", { id: id() });

    expect(titles(counted.body.similarSongs?.song)).toHaveLength(songs);
    expect(counted.statements).toHaveLength(3);
    expect(counted.rowsWritten).toBe(0);
  });

  it("skips the candidate read when no seed has a genre and no artist has top songs to ask for", async () => {
    const counted = await infoCounting("getSimilarSongs", { id: FALLBACK_ALBUM });

    expect(titles(counted.body.similarSongs?.song)).toEqual(["01 Untagged"]);
    expect(counted.statements).toHaveLength(2);
  });

  it("runs nothing beyond authentication for count=0", async () => {
    const counted = await infoCounting("getSimilarSongs", { id: QUIET, count: "0" });

    expect(counted.body.similarSongs).toEqual({});
    expect(counted.statements).toHaveLength(1);
  });
});
