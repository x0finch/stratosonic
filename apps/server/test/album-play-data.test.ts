import { albumId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { write } from "./annotations-support";
import { bootstrapAdmin, browse } from "./browsing-support";
import { seedAlbum, seedArtist, seedTrack } from "./support";

/**
 * What a `scrobble` submission leaves on the *album* a track belongs to.
 *
 * A play counts for the album as well as the track, which is what fills the
 * `frequent` and `recent` album lists. Two things about that write are worth
 * asserting on their own: several tracks of one album submitted together are
 * one album play row carrying all of them, and an instant that arrives late —
 * an offline backlog flushing out of order — never drags the album's `played`
 * backwards.
 */

const ARTIST = "Pulsar";
const YEAR = 1999;

const ALBUM = "Quasar";
const FIRST = `${ARTIST}/${ALBUM}/01 First.mp3`;
const SECOND = `${ARTIST}/${ALBUM}/02 Second.mp3`;

const ALBUM_ID = prefixedId("album", albumId(ARTIST, ALBUM, YEAR));
const trackIdOf = (key: string) => prefixedId("track", trackId(key));

/** The album's aggregate play data, as `getAlbum` renders it for the caller. */
async function albumPlayData(): Promise<{ playCount?: number; played?: string }> {
  const album = (await browse("getAlbum", { id: ALBUM_ID })).album;

  return { playCount: album?.playCount, played: album?.played };
}

beforeAll(async () => {
  await bootstrapAdmin();
  await seedArtist({ name: ARTIST });
  await seedAlbum({ name: ALBUM, albumArtist: ARTIST, year: YEAR, songCount: 2 });
  for (const key of [FIRST, SECOND]) {
    await seedTrack({ r2Key: key, album: ALBUM, albumArtist: ARTIST, year: YEAR });
  }
});

describe("two tracks of one album in one submission", () => {
  it("counts both plays on the album and keeps the later instant", async () => {
    await write("scrobble", {
      id: [trackIdOf(FIRST), trackIdOf(SECOND)],
      time: ["3000", "1000"],
    });

    expect(await albumPlayData()).toEqual({
      playCount: 2,
      played: new Date(3000).toISOString(),
    });
  });
});

describe("a backlogged submission", () => {
  it("counts the play without moving the album's played backwards", async () => {
    await write("scrobble", { id: trackIdOf(FIRST), time: "2000" });

    expect(await albumPlayData()).toEqual({
      playCount: 3,
      played: new Date(3000).toISOString(),
    });
  });
});
