import { albumId, artistId, prefixedId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browse, fixtureAlbum } from "./browsing-support";
import { fixtureBytes, fixtures, fixtureTrack } from "./fixtures/files";
import {
  bucketKeys,
  coverUploads,
  SCAN_TIME,
  scan,
  seedFixtureFiles,
  storedAlbums,
  storedArtists,
  storedTracks,
} from "./scan-support";
import { fixtureCoverKey, testEnv } from "./support";

/**
 * What later passes make of a bucket that changed underneath them: a file
 * whose bytes are different, and files that are gone.
 *
 * The fixtures are seeded and scanned once in `beforeAll`, and each block
 * below changes the bucket and scans again, so the tests read as the history
 * of one library rather than four separate ones.
 */

const CHANGED = fixtureTrack("silent-track.mp3");
const CHANGED_ALBUM = fixtureAlbum("Quiet Album");
const REMOVED = fixtureTrack("front-loaded.m4a");
const REMOVED_ALBUM = fixtureAlbum("Faststart Sessions");
const LAST_OF_ITS_ARTIST = fixtureTrack("tail-loaded.m4a");
const EMPTIED_ARTIST = fixtureAlbum("Trailing Sessions");

/** A later run, so a rewritten row's `updatedAt` is visibly newer. */
function minutesLater(minutes: number): Date {
  return new Date(SCAN_TIME.getTime() + minutes * 60_000);
}

/** The covers the first pass wrote, and when. */
let coversAfterFirstScan: Map<string, number>;

beforeAll(async () => {
  await bootstrapAdmin();
  await seedFixtureFiles();
  await scan();
  coversAfterFirstScan = await coverUploads();
});

describe("a track whose bytes changed", () => {
  it("is read again, and only it", async () => {
    // The same audio with one byte appended: enough for a different etag and
    // size, which is the pair the scan compares, and it still parses.
    await testEnv.MUSIC.put(CHANGED.r2Key, new Uint8Array([...fixtureBytes(CHANGED.file), 0]));

    const run = await scan(minutesLater(15));

    expect(run.completed).toBe(true);
    expect(run.counts.updated).toBe(1);
    expect(run.counts.added).toBe(0);
    expect(run.counts.unchanged).toBe(fixtures.tracks.length - 1);

    const changed = (await storedTracks()).find((row) => row.r2Key === CHANGED.r2Key);
    expect(changed?.size).toBe(CHANGED.size + 1);
    expect(changed?.updatedAt.getTime()).toBe(minutesLater(15).getTime());
  });

  it("brings its album's stored size back in line with its tracks", async () => {
    const stored = (await storedAlbums()).find((row) => row.name === CHANGED_ALBUM.name);
    const bytes = CHANGED_ALBUM.trackFiles
      .map((file) => fixtureTrack(file).size)
      .reduce((total, size) => total + size, 0);

    expect(stored?.songCount).toBe(CHANGED_ALBUM.trackFiles.length);
    expect(stored?.size).toBe(bytes + 1);
  });

  it("refreshes its album's artwork, and leaves every other album's alone", async () => {
    const refreshed = fixtureCoverKey(CHANGED_ALBUM);
    const now = await coverUploads();

    expect(new Set(now.keys())).toEqual(new Set(coversAfterFirstScan.keys()));
    for (const [key, uploadedAt] of now) {
      if (key === refreshed) {
        expect(uploadedAt).toBeGreaterThan(coversAfterFirstScan.get(key) ?? 0);
      } else {
        expect(uploadedAt).toBe(coversAfterFirstScan.get(key));
      }
    }
  });
});

describe("a track whose object is gone", () => {
  it("is swept, and takes its emptied album and its cover with it", async () => {
    await testEnv.MUSIC.delete(REMOVED.r2Key);

    const run = await scan(minutesLater(30));

    expect(run.completed).toBe(true);
    expect(run.counts.removed).toBe(1);
    expect(run.counts.albumsRemoved).toBe(1);
    expect(run.counts.artistsRemoved).toBe(0);

    expect((await storedTracks()).map((row) => row.r2Key)).not.toContain(REMOVED.r2Key);
    expect((await storedAlbums()).map((row) => row.name)).not.toContain(REMOVED_ALBUM.name);
    expect(await bucketKeys("_covers/")).not.toContain(fixtureCoverKey(REMOVED_ALBUM));
  });

  it("leaves an artist that still has an album alone", async () => {
    expect((await storedArtists()).map((row) => row.name)).toContain(REMOVED_ALBUM.albumArtist);
  });

  it("prunes the artist once its last album goes", async () => {
    await testEnv.MUSIC.delete(LAST_OF_ITS_ARTIST.r2Key);

    const run = await scan(minutesLater(45));

    expect(run.counts.removed).toBe(1);
    expect(run.counts.albumsRemoved).toBe(1);
    expect(run.counts.artistsRemoved).toBe(1);
    expect((await storedArtists()).map((row) => row.name)).not.toContain(
      EMPTIED_ARTIST.albumArtist,
    );
  });

  it("no longer answers for the artist or the album a client used to ask for", async () => {
    const artist = await browse("getArtist", {
      id: prefixedId("artist", artistId(EMPTIED_ARTIST.albumArtist)),
    });
    const album = await browse("getAlbum", {
      id: prefixedId(
        "album",
        albumId(EMPTIED_ARTIST.albumArtist, EMPTIED_ARTIST.name, EMPTIED_ARTIST.year),
      ),
    });

    expect(artist.error?.code).toBe(70);
    expect(album.error?.code).toBe(70);
  });

  it("still holds everything the bucket still holds", async () => {
    expect((await storedTracks()).map((row) => row.r2Key)).toEqual(
      fixtures.tracks
        .map((fixture) => fixture.r2Key)
        .filter((key) => key !== REMOVED.r2Key && key !== LAST_OF_ITS_ARTIST.r2Key)
        .sort(),
    );
  });
});
