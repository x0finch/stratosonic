import { runInDurableObject } from "cloudflare:test";
import {
  albumId,
  annotation,
  artist,
  artistId,
  bookmark,
  library,
  playlistTrack,
  property,
  subsonicUser,
  type Track,
  track,
  trackLyrics,
  userLibrary,
} from "@stratosonic/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { CLEANUP_TRACKS_PER_STEP } from "../src/scanner/cleanup";
import type { ScanDriver } from "../src/scanner/driver";
import { brokenObjectsKey, readLastScanSummary } from "../src/scanner/state";
import { bootstrapAdmin } from "./browsing-support";
import { driver, driveUntilIdle, poke, runNextAlarm, slowTuning } from "./driver-support";
import type { FakeS3 } from "./fake-s3";
import {
  ARCHIVE,
  connectLibrary,
  type FakeLibrary,
  installFakeLibrary,
  libraryRow,
  resetLibraries,
  tracksIn,
} from "./scan-libraries-support";
import {
  SEED_TIME,
  seedAlbum,
  seedAnnotation,
  seedArtist,
  seedPlaylist,
  seedTrack,
  testEnv,
} from "./support";

/**
 * The cleanup of a removed library (#84, "Removing a library", step 2): the
 * first phase of a pass deletes, in bounded batches, everything a library
 * marked `removing` left in the index, and finally its row. Its bucket is
 * never touched: the fake S3 endpoint behind library 2 records no call.
 */

const T = new Date(1_790_000_000_000);

const SHARED = "Shared Artist";
const ONLY_TWO = "Only Two";
const ONLY_ONE = "Only One";

let fake: FakeS3;
let installed: FakeLibrary;
let adminId: string;

beforeAll(async () => {
  await bootstrapAdmin();
  const [admin] = await database(testEnv).select().from(subsonicUser);
  adminId = admin?.id ?? "";
});

beforeEach(async () => {
  await resetLibraries();
  installed = installFakeLibrary();
  fake = installed.fake;
  await connectLibrary(fake);
});

afterEach(async () => {
  await driveUntilIdle();
  installed.spy.mockRestore();
});

/**
 * Runs the driver's alarms until library 2's row is gone, then stops the
 * pass: the scan that follows would sweep the rows these tests seed in
 * library 1 without objects. Answers how many alarms the cleanup took.
 */
async function cleanUp(limit = 20): Promise<number> {
  for (let alarm = 1; alarm <= limit; alarm++) {
    await runNextAlarm();
    if ((await libraryRow(ARCHIVE.id)) === undefined) {
      await runInDurableObject(driver(), async (_instance: ScanDriver, state) => {
        await state.storage.deleteAlarm();
        await state.storage.deleteAll();
      });
      return alarm;
    }
  }
  throw new Error(`library 2 was still there after ${limit} alarms`);
}

/** Marks library 2 `removing`, as `DELETE /api/libraries/:id` does. */
async function markRemoving(): Promise<void> {
  const db = database(testEnv);
  await db.update(library).set({ state: "removing" }).where(eq(library.id, ARCHIVE.id));
  await db.delete(userLibrary).where(eq(userLibrary.libraryId, ARCHIVE.id));
}

function annotationOf(itemId: string, itemType: "track" | "album" | "artist" | "playlist") {
  return database(testEnv)
    .select()
    .from(annotation)
    .where(and(eq(annotation.itemId, itemId), eq(annotation.itemType, itemType)));
}

describe("removing library 2", () => {
  let one: Track;
  let two: Track;
  let twoAlone: Track;
  let alarms = 0;
  const coverOfShared = `_covers/${albumId(ARCHIVE.id, SHARED, "Shared", 2001)}.jpg`;
  const coverOfTwo = `_covers/${albumId(ARCHIVE.id, ONLY_TWO, "Two", 2002)}.jpg`;
  const coverOfOne = `_covers/${albumId(1, SHARED, "Shared", 2001)}.jpg`;

  beforeEach(async () => {
    const db = database(testEnv);
    for (const name of [SHARED, ONLY_TWO, ONLY_ONE]) {
      await seedArtist({ name });
    }
    await seedAlbum({ name: "Shared", albumArtist: SHARED, year: 2001, coverKey: coverOfOne });
    await seedAlbum({ name: "One", albumArtist: ONLY_ONE, year: 2003 });
    await seedAlbum({
      libraryId: ARCHIVE.id,
      name: "Shared",
      albumArtist: SHARED,
      year: 2001,
      coverKey: coverOfShared,
    });
    await seedAlbum({
      libraryId: ARCHIVE.id,
      name: "Two",
      albumArtist: ONLY_TWO,
      year: 2002,
      coverKey: coverOfTwo,
    });
    for (const key of [coverOfShared, coverOfTwo, coverOfOne]) {
      await testEnv.MUSIC.put(key, new Uint8Array([1, 2, 3]));
    }

    one = await seedTrack({ r2Key: `${SHARED}/Shared/01 One.mp3`, year: 2001 });
    two = await seedTrack({
      libraryId: ARCHIVE.id,
      r2Key: `${SHARED}/Shared/01 One.mp3`,
      year: 2001,
    });
    twoAlone = await seedTrack({
      libraryId: ARCHIVE.id,
      r2Key: `${ONLY_TWO}/Two/01 Alone.mp3`,
      year: 2002,
    });
    await db.insert(trackLyrics).values({ trackId: two.id, text: "la la", lang: "eng" });

    // Stars on everything, and bookmarks on both libraries' tracks.
    for (const [itemId, itemType] of [
      [one.id, "track"],
      [two.id, "track"],
      [twoAlone.id, "track"],
      [albumId(1, SHARED, "Shared", 2001), "album"],
      [albumId(ARCHIVE.id, SHARED, "Shared", 2001), "album"],
      [albumId(ARCHIVE.id, ONLY_TWO, "Two", 2002), "album"],
      [artistId(SHARED), "artist"],
      [artistId(ONLY_TWO), "artist"],
      [artistId(ONLY_ONE), "artist"],
    ] as const) {
      await seedAnnotation({ userId: adminId, itemId, itemType });
    }
    for (const entry of [one, two]) {
      await db.insert(bookmark).values({
        userId: adminId,
        trackId: entry.id,
        position: 1000,
        createdAt: SEED_TIME,
        changedAt: SEED_TIME,
      });
    }

    // A library-1 playlist holding a track of each library, and the
    // annotation of a library-2 playlist the removal request deleted.
    const kept = await seedPlaylist({
      r2Key: "playlists/mixed.m3u",
      ownerId: adminId,
      tracks: [one, two],
    });
    await seedAnnotation({ userId: adminId, itemId: kept.id, itemType: "playlist" });
    await seedAnnotation({ userId: adminId, itemId: "deleted-playlist", itemType: "playlist" });

    await db
      .insert(property)
      .values({ id: brokenObjectsKey(ARCHIVE.id), value: JSON.stringify({ "x.mp3": "e" }) });

    await markRemoving();
    await poke(T, slowTuning);
    alarms = await cleanUp();
  });

  it("deletes its tracks, their lyrics, annotations and bookmarks, and keeps library 1's", async () => {
    const db = database(testEnv);
    expect(await tracksIn(ARCHIVE.id)).toEqual([]);
    expect((await tracksIn(1)).map((row) => row.id)).toEqual([one.id]);
    expect(await db.select().from(trackLyrics)).toEqual([]);
    expect(await annotationOf(two.id, "track")).toEqual([]);
    expect(await annotationOf(twoAlone.id, "track")).toEqual([]);
    expect(await annotationOf(one.id, "track")).toHaveLength(1);
    expect((await db.select().from(bookmark)).map((row) => row.trackId)).toEqual([one.id]);
  });

  it("deletes its albums, their annotations and their covers in the bound bucket", async () => {
    expect(await annotationOf(albumId(ARCHIVE.id, SHARED, "Shared", 2001), "album")).toEqual([]);
    expect(await annotationOf(albumId(ARCHIVE.id, ONLY_TWO, "Two", 2002), "album")).toEqual([]);
    expect(await annotationOf(albumId(1, SHARED, "Shared", 2001), "album")).toHaveLength(1);
    expect(await testEnv.MUSIC.head(coverOfShared)).toBeNull();
    expect(await testEnv.MUSIC.head(coverOfTwo)).toBeNull();
    expect(await testEnv.MUSIC.head(coverOfOne)).not.toBeNull();
  });

  it("drops its playlist entries and the deleted playlists' annotations", async () => {
    const db = database(testEnv);
    expect((await db.select().from(playlistTrack)).map((row) => row.trackId)).toEqual([one.id]);
    expect(await annotationOf("deleted-playlist", "playlist")).toEqual([]);
    expect(
      await db.select().from(annotation).where(eq(annotation.itemType, "playlist")),
    ).toHaveLength(1);
  });

  it("keeps the shared artist with its stars, and removes the one only it had, with its stars", async () => {
    const db = database(testEnv);
    const names = (await db.select().from(artist)).map((row) => row.name).sort();
    expect(names).toEqual([ONLY_ONE, SHARED].sort());
    expect(await annotationOf(artistId(SHARED), "artist")).toHaveLength(1);
    expect(await annotationOf(artistId(ONLY_TWO), "artist")).toEqual([]);
    expect(await annotationOf(artistId(ONLY_ONE), "artist")).toHaveLength(1);
  });

  it("deletes its memo, and finally its row", async () => {
    const db = database(testEnv);
    expect(
      await db
        .select()
        .from(property)
        .where(eq(property.id, brokenObjectsKey(ARCHIVE.id))),
    ).toEqual([]);
    expect(await libraryRow(ARCHIVE.id)).toBeUndefined();
    expect((await libraryRow(1))?.state).toBe("active");
  });

  it("never reaches the library's bucket", () => {
    expect(fake.calls).toEqual([]);
  });

  it("is the first phase of a pass, one bounded batch a step", async () => {
    // The tracks, the albums, then the rest and the row.
    expect(alarms).toBe(3);
    expect(await readLastScanSummary(database(testEnv))).toBeNull();
  });
});

describe("removing a large library", () => {
  it(`deletes at most ${CLEANUP_TRACKS_PER_STEP} tracks a step`, async () => {
    const db = database(testEnv);
    await seedArtist({ name: ONLY_TWO });
    await seedAlbum({ libraryId: ARCHIVE.id, name: "Big", albumArtist: ONLY_TWO });
    const rows = Array.from({ length: 2 * CLEANUP_TRACKS_PER_STEP + 1 }, (_, index) => {
      const r2Key = `${ONLY_TWO}/Big/${String(index).padStart(4, "0")}.mp3`;
      return { r2Key, libraryId: ARCHIVE.id };
    });
    for (let start = 0; start < rows.length; start += 40) {
      await Promise.all(rows.slice(start, start + 40).map((seed) => seedTrack(seed)));
    }
    await markRemoving();

    await poke(T, slowTuning);
    const left: number[] = [];
    for (let step = 0; step < 3; step++) {
      await runNextAlarm();
      left.push(
        (await db.select({ id: track.id }).from(track).where(eq(track.libraryId, ARCHIVE.id)))
          .length,
      );
    }

    expect(left).toEqual([CLEANUP_TRACKS_PER_STEP + 1, 1, 0]);
    expect(await libraryRow(ARCHIVE.id)).toBeDefined();

    await driveUntilIdle();
    expect(await libraryRow(ARCHIVE.id)).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });

  it("counts its writes against the daily budget", async () => {
    await seedArtist({ name: ONLY_TWO });
    await seedAlbum({ libraryId: ARCHIVE.id, name: "Big", albumArtist: ONLY_TWO });
    for (let index = 0; index < 10; index++) {
      await seedTrack({ libraryId: ARCHIVE.id, r2Key: `${ONLY_TWO}/Big/${index}.mp3` });
    }
    await markRemoving();

    // Six rows a track: the first step's ten tracks spend the budget.
    await poke(T, { ...slowTuning, writeBudget: 50 });
    await driveUntilIdle();

    expect(await tracksIn(ARCHIVE.id)).toEqual([]);
    expect(await libraryRow(ARCHIVE.id)).toBeDefined();
    expect(await readLastScanSummary(database(testEnv))).toBeNull();
  });
});
