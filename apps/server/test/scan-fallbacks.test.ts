import { prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { UNKNOWN_ALBUM, UNKNOWN_ARTIST } from "../src/scanner/derive";
import { bootstrapAdmin, browse } from "./browsing-support";
import { fixtureBytes, fixtures, fixtureTrack } from "./fixtures/files";
import { scan, seedFixtureFiles, storedTracks } from "./scan-support";
import { testEnv } from "./support";

/**
 * What the scan makes of objects that do not cooperate: a file with no tags,
 * a file with no path to read a name off either, bytes that are not audio at
 * all, and objects that are not music in the first place.
 *
 * None of them may end a run, and none of them may land in the library as a
 * nameless, silent track.
 */

/** Tagless audio, but filed the way the library is filed. */
const UNTAGGED = fixtureTrack("untagged.mp3");

/** Tagless audio at the root of the bucket: nothing to fall back to. */
const ROOTLESS_KEY = "stray.mp3";

/** An object whose suffix promises audio and whose bytes are not. */
const CORRUPT_KEY = "Broken Artist/Broken Album/01 Not Audio.mp3";

/** Objects the scan must never mistake for tracks. */
const NOT_MUSIC = ["notes.txt", "Silent Artist/Quiet Album/folder.jpg", "artwork"];

beforeAll(async () => {
  await bootstrapAdmin();
  await seedFixtureFiles();

  await testEnv.MUSIC.put(ROOTLESS_KEY, fixtureBytes(UNTAGGED.file));
  // 'A' repeated: no MPEG frame sync anywhere in it, so no parser can find a
  // stream however hard it looks.
  await testEnv.MUSIC.put(CORRUPT_KEY, new Uint8Array(5000).fill(0x41));
  for (const key of NOT_MUSIC) {
    await testEnv.MUSIC.put(key, new TextEncoder().encode(key));
  }
});

describe("a scan of a bucket that is not all music", () => {
  it("counts the file it could not read, and finishes the pass anyway", async () => {
    const run = await scan();

    expect(run.completed).toBe(true);
    expect(run.counts.broken).toBe(1);
    expect(run.counts.deferred).toBe(0);
    expect(run.counts.indexed).toBe(fixtures.tracks.length + 1);
  });

  it("indexes the audio and nothing else", async () => {
    expect((await storedTracks()).map((row) => row.r2Key)).toEqual(
      [...fixtures.tracks.map((fixture) => fixture.r2Key), ROOTLESS_KEY].sort(),
    );
  });

  it("does not index the object whose bytes are not what its suffix promised", async () => {
    const body = await browse("getSong", { id: prefixedId("track", trackId(CORRUPT_KEY)) });

    expect(body.error?.code).toBe(70);
  });

  it("reads a tagless file's names off its path", async () => {
    const body = await browse("getSong", {
      id: prefixedId("track", trackId(UNTAGGED.r2Key)),
    });

    expect(body.song?.title).toBe(UNTAGGED.pathFallback.title);
    expect(body.song?.artist).toBe(UNTAGGED.pathFallback.albumArtist);
    expect(body.song?.album).toBe(UNTAGGED.pathFallback.album);
    expect(body.song?.year).toBeUndefined();
    expect(body.song?.genre).toBeUndefined();
    expect(body.song?.coverArt).toBeUndefined();
  });

  it("falls back to Navidrome's unknown names only when the path says nothing", async () => {
    const body = await browse("getSong", { id: prefixedId("track", trackId(ROOTLESS_KEY)) });

    expect(body.song?.title).toBe("stray");
    expect(body.song?.artist).toBe(UNKNOWN_ARTIST);
    expect(body.song?.album).toBe(UNKNOWN_ALBUM);
  });

  it("finds the same broken file again next pass, and is no worse for it", async () => {
    const run = await scan();

    expect(run.completed).toBe(true);
    expect(run.counts.broken).toBe(1);
    expect(run.counts.indexed).toBe(0);
    expect(run.counts.removed).toBe(0);
  });
});
