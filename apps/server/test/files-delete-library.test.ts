import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { type CookieJar, seedConsoleUser, signIn } from "./console-auth-support";
import { driverIsIdle, driveUntilIdle, poke } from "./driver-support";
import { filesHarness } from "./files-support";
import {
  bucketKeys,
  resetLibrary,
  seedFixtureFiles,
  storedAlbums,
  storedTracks,
} from "./scan-support";
import { BASE } from "./support";

/**
 * A delete and the library (#83, "Delete and the library"): the route
 * deletes only the objects, and the pass the change schedules takes the
 * tracks out, recomputes and prunes the emptied album, and deletes its cover
 * object, as the scan does for any object that went (scanner/scan.ts).
 *
 * The library is the fixtures', indexed by a real pass, in a file of its
 * own so nothing else shares its rows.
 */

const ORIGIN = "https://files-library.stratosonic.test";
const harness = filesHarness(ORIGIN);
const QUIET_ALBUM = [
  "Silent Artist/Quiet Album/01 Silent Track.mp3",
  "Silent Artist/Quiet Album/02 Hushed Interlude.flac",
];

let owner: CookieJar;

beforeAll(async () => {
  // The bootstrap's Subsonic admin, which a pass's playlist import needs.
  await SELF.fetch(`${BASE}/rest/ping`);
  await seedConsoleUser("owner", "library");
  owner = (await signIn(harness.send, ORIGIN, "owner", "library")).jar;

  await resetLibrary();
  await seedFixtureFiles();
  await poke(new Date());
  await driveUntilIdle();
});

describe("deleting an album's tracks", () => {
  it("leaves their rows until the pass, which then removes the tracks, the album and its cover", async () => {
    const albums = await storedAlbums();
    const quiet = albums.find((album) => album.name === "Quiet Album");
    const coverKey = quiet?.coverKey;
    expect(coverKey).toMatch(/^_covers\//);
    expect((await storedTracks()).map((track) => track.r2Key)).toEqual(
      expect.arrayContaining(QUIET_ALBUM),
    );
    expect(await bucketKeys("_covers/")).toContain(coverKey);

    const response = await harness.call(owner, "POST", "/files/delete", { keys: QUIET_ALBUM });
    expect(response.status).toBe(200);

    // The objects are gone; the rows wait for the pass.
    const keys = await bucketKeys();
    expect(keys).not.toContain(QUIET_ALBUM[0]);
    expect(keys).not.toContain(QUIET_ALBUM[1]);
    expect((await storedTracks()).map((track) => track.r2Key)).toEqual(
      expect.arrayContaining(QUIET_ALBUM),
    );
    expect((await storedAlbums()).map((album) => album.name)).toContain("Quiet Album");
    expect(await driverIsIdle()).toBe(false);

    await driveUntilIdle();

    const tracks = (await storedTracks()).map((track) => track.r2Key);
    expect(tracks).not.toContain(QUIET_ALBUM[0]);
    expect(tracks).not.toContain(QUIET_ALBUM[1]);
    expect(tracks.length).toBeGreaterThan(0);
    const remaining = (await storedAlbums()).map((album) => album.name);
    expect(remaining).not.toContain("Quiet Album");
    expect(remaining).toContain("Faststart Sessions");
    expect(await bucketKeys("_covers/")).not.toContain(coverKey);
  });
});
