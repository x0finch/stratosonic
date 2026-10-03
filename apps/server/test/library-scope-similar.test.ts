import { artistId, type Track, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN,
  countingApp,
  LISTENER_TWO,
  type SubsonicJson,
  seedTwoLibraries,
} from "./library-scope-support";
import { seedAlbum, seedArtist, seedPlaylist, seedTrack } from "./support";

/**
 * `getSimilarSongs` seeded from an artist or a playlist that reaches into a
 * library the caller cannot see (#84: "scope on every pool").
 *
 * Each seed below carries a genre no other track has, so the genre sample is
 * empty and Navidrome's `seedMix` falls back to the seeds themselves: a seed
 * drawn from library 1 would come straight out in the mix. Only the scope on
 * the seed reads (the artist's and the playlist's track joins) keeps it out.
 */

const { call } = countingApp();

const POLKA_KEY = "Crossover/Polka Days/01 Polka.flac";
const ZYDECO_KEY = "Crossover/Crossing/01 Zydeco.flac";
const POLKA = `tr-${trackId(1, POLKA_KEY)}`;
const ZYDECO = `tr-${trackId(2, ZYDECO_KEY)}`;

let playlistId = "";

beforeAll(async () => {
  const { adminId } = await seedTwoLibraries();
  await seedArtist({ name: "Crossover" });

  // One artist, a track in each library, each in a genre no other track has.
  await seedAlbum({ name: "Polka Days", albumArtist: "Crossover", genre: "Polka", songCount: 1 });
  const polka: Track = await seedTrack({ r2Key: POLKA_KEY, genre: "Polka" });
  await seedAlbum({
    libraryId: 2,
    name: "Crossing",
    albumArtist: "Crossover",
    genre: "Zydeco",
    songCount: 1,
  });
  const zydeco: Track = await seedTrack({ libraryId: 2, r2Key: ZYDECO_KEY, genre: "Zydeco" });

  // The admin's public playlist, one entry in each library.
  const row = await seedPlaylist({
    r2Key: "playlists/Crossover.m3u",
    ownerId: adminId,
    public: true,
    tracks: [polka, zydeco],
  });
  playlistId = `pl-${row.id}`;
});

/** The songs of a `getSimilarSongs` answer. */
function songsOf(body: SubsonicJson): string[] {
  expect(body.status, JSON.stringify(body.error)).toBe("ok");
  return (body.similarSongs?.song ?? []).map((song: SubsonicJson) => song.id).sort();
}

describe("getSimilarSongs seeded across libraries", () => {
  it("draws an artist's seeds only from the libraries in scope", async () => {
    const id = `ar-${artistId("Crossover")}`;

    expect(songsOf(await call(LISTENER_TWO, "getSimilarSongs", [["id", id]]))).toEqual([ZYDECO]);
    expect(songsOf(await call(ADMIN, "getSimilarSongs", [["id", id]]))).toEqual(
      [POLKA, ZYDECO].sort(),
    );
  });

  it("draws a playlist's seeds only from its entries in scope", async () => {
    expect(songsOf(await call(LISTENER_TWO, "getSimilarSongs", [["id", playlistId]]))).toEqual([
      ZYDECO,
    ]);
    expect(songsOf(await call(ADMIN, "getSimilarSongs", [["id", playlistId]]))).toEqual(
      [POLKA, ZYDECO].sort(),
    );
  });
});
