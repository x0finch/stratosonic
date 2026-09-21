import { trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browseXml } from "./browsing-support";
import { adminUserId, list, songTitles } from "./lists-support";
import { seedAlbum, seedAnnotation, seedArtist, seedTrack } from "./support";

/**
 * `getTopSongs`: the songs a client puts at the top of an artist's page.
 *
 * Navidrome asks last.fm; this server has no outbound calls, so it ranks the
 * artist's own tracks by what the caller has played, then by how they rated
 * them, then by title. The seeds below set play counts and ratings that make
 * every one of those three keys decide a pair, and leave one track with no
 * annotation at all, which has to come back last rather than not at all.
 */

const ARTIST = "Ridge";
const ALBUM = "Ledger";
const SILENT = "Cairn";
const CHARTS = "Volume";
const CHARTS_ALBUM = "Everything";

/** How many tracks the busy artist has: one more than the default count. */
const CHARTS_TRACKS = 51;

/**
 * The tracks of the artist under test and the caller's state for each.
 *
 * `Second` and `Third` share a play count, so the rating separates them;
 * `Fourth` and `Fifth` share both, so the title does; `Sixth` has no
 * annotation row.
 */
const TRACKS = [
  { title: "First", playCount: 9, rating: 1 },
  { title: "Third", playCount: 4, rating: 2 },
  { title: "Second", playCount: 4, rating: 5 },
  { title: "Fifth", playCount: 0, rating: 0 },
  { title: "Fourth", playCount: 0, rating: 0 },
  { title: "Sixth", playCount: null, rating: null },
];

/** The order those tracks have to come back in. */
const RANKED = ["First", "Second", "Third", "Fifth", "Fourth", "Sixth"];

function key(title: string): string {
  return `${ARTIST}/${ALBUM}/${title}.mp3`;
}

/** The artist's top songs, as titles. */
async function top(extra: Record<string, string> = {}): Promise<string[]> {
  const body = await list("getTopSongs", { artist: ARTIST, ...extra });

  return songTitles(body.topSongs?.song);
}

beforeAll(async () => {
  await bootstrapAdmin();
  const admin = await adminUserId();

  await seedArtist({ name: ARTIST });
  await seedAlbum({ name: ALBUM, albumArtist: ARTIST, year: null, songCount: TRACKS.length });

  for (const seed of TRACKS) {
    await seedTrack({
      r2Key: key(seed.title),
      title: seed.title,
      album: ALBUM,
      albumArtist: ARTIST,
      duration: 61.7,
      size: 2048,
    });

    if (seed.playCount === null) {
      continue;
    }

    await seedAnnotation({
      userId: admin,
      itemId: trackId(key(seed.title)),
      itemType: "track",
      starred: false,
      playCount: seed.playCount,
      rating: seed.rating ?? 0,
    });
  }

  // An artist whose name the library knows but which carries no track at all.
  await seedArtist({ name: SILENT });

  // An artist with more tracks than the default count, to prove the default.
  await seedArtist({ name: CHARTS });
  await seedAlbum({
    name: CHARTS_ALBUM,
    albumArtist: CHARTS,
    year: null,
    songCount: CHARTS_TRACKS,
  });

  for (let index = 0; index < CHARTS_TRACKS; index += 1) {
    await seedTrack({
      r2Key: `${CHARTS}/${CHARTS_ALBUM}/${String(index).padStart(2, "0")}.mp3`,
      album: CHARTS_ALBUM,
      albumArtist: CHARTS,
    });
  }
});

describe("getTopSongs", () => {
  it.each(["/rest/getTopSongs", "/rest/getTopSongs.view"])("answers on %s", async (path) => {
    const xml = await browseXml(path, { artist: ARTIST, count: "1" });

    expect(xml).toContain('status="ok"');
    expect(xml).toContain("<topSongs>");
    expect(xml).toContain('<song id="tr-');
    expect(xml).toContain('isDir="false"');
  });

  it("puts the most played song of the artist first", async () => {
    expect((await top())[0]).toBe("First");
  });

  it("ranks by play count, then rating, then title", async () => {
    expect(await top()).toEqual(RANKED);
  });

  it("includes a song the caller has never touched, last", async () => {
    expect((await top()).at(-1)).toBe("Sixth");
  });

  it("carries only that artist's songs", async () => {
    const body = await list("getTopSongs", { artist: ARTIST, count: "500" });
    const songs = body.topSongs?.song ?? [];

    expect(songs).toHaveLength(TRACKS.length);
    expect(songs.every((song) => song.artist === ARTIST)).toBe(true);
  });

  it("matches the artist whatever case the client sends the name in", async () => {
    expect(await top({ artist: ARTIST.toLowerCase() })).toEqual(RANKED);
  });

  it("returns as many songs as the client asked for", async () => {
    expect(await top({ count: "2" })).toEqual(["First", "Second"]);
  });

  it("returns fifty songs when the client does not ask for a count", async () => {
    const body = await list("getTopSongs", { artist: CHARTS });

    expect(body.topSongs?.song).toHaveLength(50);
  });

  it("returns nothing for a count of zero", async () => {
    const body = await list("getTopSongs", { artist: ARTIST, count: "0" });

    expect(body.status).toBe("ok");
    expect(body.topSongs).toEqual({});
  });

  it("falls back to fifty when the count is not a number", async () => {
    const body = await list("getTopSongs", { artist: CHARTS, count: "plenty" });

    expect(body.topSongs?.song).toHaveLength(50);
  });

  it("answers an artist with no songs with an empty list, not an error", async () => {
    const body = await list("getTopSongs", { artist: SILENT });

    expect(body.status).toBe("ok");
    expect(body.error).toBeUndefined();
    expect(body.topSongs).toEqual({});
  });

  it("answers an artist the library has never heard of with an empty list", async () => {
    const body = await list("getTopSongs", { artist: "Nobody At All" });

    expect(body.status).toBe("ok");
    expect(body.error).toBeUndefined();
    expect(body.topSongs).toEqual({});
  });

  it("renders an unknown artist as a childless element in XML", async () => {
    const xml = await browseXml("/rest/getTopSongs", { artist: "Nobody At All" });

    expect(xml).toContain("<topSongs/>");
    expect(xml).not.toContain("<error");
  });

  it("refuses a request with no artist", async () => {
    const body = await list("getTopSongs");

    expect(body.error).toEqual({ code: 10, message: "missing parameter: 'artist'" });
  });

  it("renders a song with a prefixed id and the caller's play count", async () => {
    const body = await list("getTopSongs", { artist: ARTIST, count: "1" });
    const song = body.topSongs?.song?.[0];

    expect(song?.id.startsWith("tr-")).toBe(true);
    expect(song?.albumId?.startsWith("al-")).toBe(true);
    expect(song?.album).toBe(ALBUM);
    expect(song?.playCount).toBe(9);
    expect(song?.userRating).toBe(1);
  });
});
