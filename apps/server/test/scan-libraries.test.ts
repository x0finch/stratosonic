import { album, property, trackId, trackLyrics } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { readBrokenObjects, readLastScanSummary, readScanState } from "../src/scanner/state";
import { bootstrapAdmin } from "./browsing-support";
import { driveUntilIdle, poke, runNextAlarm, slowTuning } from "./driver-support";
import type { FakeS3 } from "./fake-s3";
import { libraryTestBucket } from "./fake-s3";
import {
  ARCHIVE,
  connectLibrary,
  type FakeLibrary,
  installFakeLibrary,
  libraryRow,
  operationsSince,
  progressNow,
  putFixtureInArchive,
  putFixtureInBound,
  putInArchive,
  resetLibraries,
  trackAt,
  tracksIn,
} from "./scan-libraries-support";
import { testEnv } from "./support";

/**
 * The scan driver across libraries (#84, "Scanning several libraries",
 * "Testing Decisions"): library 1 is the bound bucket, library 2 an R2
 * bucket behind the fake S3 endpoint, and each pass is driven through the
 * real Durable Object's alarms.
 */

const SILENT = "Silent Artist/Quiet Album/01 Silent Track.mp3";
const FRONT = "Mute Ensemble/Faststart Sessions/01 Front Loaded.m4a";
const UNTAGGED = "Fallback Artist/Fallback Album/01 Untagged.mp3";

const T = new Date(1_790_000_000_000);
const LATER = new Date(T.getTime() + 3_600_000);

let fake: FakeS3;
let installed: FakeLibrary;

beforeAll(async () => {
  await bootstrapAdmin();
});

beforeEach(async () => {
  await resetLibraries();
  installed = installFakeLibrary();
  fake = installed.fake;
  await connectLibrary(fake);
});

afterEach(async () => {
  installed.spy.mockRestore();
  expect(await driveUntilIdle()).toBeGreaterThanOrEqual(0);
});

describe("a pass over two libraries", () => {
  beforeEach(async () => {
    await putFixtureInBound(SILENT, "silent-track.mp3");
    await putFixtureInBound(UNTAGGED, "untagged.mp3");
    await putFixtureInArchive(SILENT, "silent-track.mp3");
    await putFixtureInArchive(FRONT, "front-loaded.m4a");
  });

  it("indexes both libraries, in ascending id, and the same key in both is two tracks", async () => {
    // One object a step, so the order of the walk shows step by step.
    await poke(T, { ...slowTuning, scanLimits: { pageSize: 1, pagesPerRun: 1 } });
    const walked: number[] = [];
    for (let step = 0; step < 20; step++) {
      const progress = await progressNow();
      if (progress !== null) {
        walked.push(progress.libraryId);
      }
      if (!(await runNextAlarm())) {
        break;
      }
    }

    expect(walked).toContain(1);
    expect(walked).toContain(ARCHIVE.id);
    expect([...walked].sort((a, b) => a - b)).toEqual(walked);

    expect((await tracksIn(1)).map((row) => row.r2Key)).toEqual([UNTAGGED, SILENT]);
    expect((await tracksIn(ARCHIVE.id)).map((row) => row.r2Key)).toEqual([FRONT, SILENT]);
    expect((await trackAt(1, SILENT))?.id).toBe(trackId(1, SILENT));
    expect((await trackAt(ARCHIVE.id, SILENT))?.id).toBe(trackId(ARCHIVE.id, SILENT));

    const summary = await readLastScanSummary(database(testEnv));
    expect(summary?.startedAt).toBe(T.getTime());
    expect(summary?.counts.added).toBe(4);
    expect(summary?.libraries["1"]?.added).toBe(2);
    expect(summary?.libraries["2"]?.added).toBe(2);
  });

  it("stamps each library as the pass enters and leaves it, with no error", async () => {
    await poke(T);
    await driveUntilIdle();

    for (const id of [1, ARCHIVE.id]) {
      const row = await libraryRow(id);
      expect(row?.lastScanStartedAt?.getTime()).toBe(T.getTime());
      expect(row?.lastScanAt?.getTime()).toBe(T.getTime());
      expect(row?.lastScanError).toBeNull();
    }
  });

  it("writes library 2's covers to the bound bucket, never to its own", async () => {
    await poke(T);
    await driveUntilIdle();

    const covers = await database(testEnv)
      .select({ id: album.id, coverKey: album.coverKey })
      .from(album)
      .where(eq(album.libraryId, ARCHIVE.id));
    expect(covers.length).toBe(2);
    for (const { id, coverKey } of covers) {
      expect(coverKey).toMatch(new RegExp(`^_covers/${id}\\.`));
      expect(await testEnv.MUSIC.head(coverKey ?? "")).not.toBeNull();
    }
    expect(fake.calls.filter((call) => call.operation === "PutObject")).toEqual([]);
    expect((await libraryTestBucket().list({ prefix: "_covers/" })).objects).toEqual([]);
  });

  it("sweeps a deletion in library 2 from library 2 only", async () => {
    await poke(T);
    await driveUntilIdle();

    await libraryTestBucket().delete(SILENT);
    await poke(LATER);
    await driveUntilIdle();

    expect(await trackAt(ARCHIVE.id, SILENT)).toBeUndefined();
    expect(await trackAt(1, SILENT)).toBeDefined();
    const summary = await readLastScanSummary(database(testEnv));
    expect(summary?.libraries["2"]?.removed).toBe(1);
    expect(summary?.libraries["1"]?.removed).toBe(0);
  });

  it("leaves _covers/ to be scanned in a library other than 1", async () => {
    await putFixtureInArchive("_covers/Someone/Something/01 Real.mp3", "silent-track.mp3");
    await poke(T);
    await driveUntilIdle();

    expect(await trackAt(ARCHIVE.id, "_covers/Someone/Something/01 Real.mp3")).toBeDefined();
  });
});

describe("a pass v0.5.0 left in flight", () => {
  it("resumes in library 1, from its cursor, then scans library 2", async () => {
    await putFixtureInBound(SILENT, "silent-track.mp3");
    await putFixtureInBound(UNTAGGED, "untagged.mp3");
    await putFixtureInArchive(FRONT, "front-loaded.m4a");

    // One page of library 1 by the new code, then its row rewritten in
    // v0.5.0's shape: no library, no restart flag, no per-library counts.
    await poke(T, { ...slowTuning, scanLimits: { pageSize: 1, pagesPerRun: 1 } });
    await runNextAlarm();
    const db = database(testEnv);
    const { progress } = await readScanState(db);
    expect(progress?.libraryId).toBe(1);
    expect(progress?.cursor).not.toBe("");
    const { startedAt, cursor, skip, sweptTo, counts } = progress ?? ({} as never);
    await db
      .update(property)
      .set({ value: JSON.stringify({ startedAt, cursor, skip, sweptTo, counts }) })
      .where(eq(property.id, "ScanProgress"));

    expect((await progressNow())?.libraryId).toBe(1);
    await driveUntilIdle();

    // Resumed, not restarted: library 1's first object is never seen again,
    // so nothing in the pass is unchanged.
    const summary = await readLastScanSummary(db);
    expect(summary?.startedAt).toBe(T.getTime());
    expect(summary?.counts.added).toBe(3);
    expect(summary?.counts.unchanged).toBe(0);
    expect(await trackAt(ARCHIVE.id, FRONT)).toBeDefined();
  });
});

describe("the memo of broken objects", () => {
  const BROKEN = "Broken Artist/Broken Album/01 Not Audio.mp3";

  it("is kept per library, and forgets a key only where it left", async () => {
    const garbage = new Uint8Array(5000).fill(0x41);
    await testEnv.MUSIC.put(BROKEN, garbage);
    await putInArchive(BROKEN, garbage);

    await poke(T);
    await driveUntilIdle();
    const db = database(testEnv);
    expect((await readBrokenObjects(db, 1)).has(BROKEN)).toBe(true);
    expect((await readBrokenObjects(db, ARCHIVE.id)).has(BROKEN)).toBe(true);

    // Known broken in both: a second pass reads it in neither.
    const before = fake.calls.length;
    await poke(LATER);
    await driveUntilIdle();
    expect(operationsSince(fake, before)).not.toContain("GetObject");

    await libraryTestBucket().delete(BROKEN);
    await poke(new Date(LATER.getTime() + 60_000));
    await driveUntilIdle();
    expect((await readBrokenObjects(db, 1)).has(BROKEN)).toBe(true);
    expect((await readBrokenObjects(db, ARCHIVE.id)).has(BROKEN)).toBe(false);
  });
});

describe("a key that hashes to another library's track id (ADR-0009)", () => {
  // Library 2's `A/B/01.mp3` is `newHashId("2", key)`, which is library 1's
  // id for the key `2` U+200B `A/B/01.mp3`.
  const KEY = "Lyric Artist/Lyric Album/01 Song.mp3";
  const SHAPED = `2​${KEY}`;

  it("collides as the ids say", () => {
    expect(trackId(ARCHIVE.id, KEY)).toBe(trackId(1, SHAPED));
  });

  it("is left out of library 2, with library 1's track and lyrics untouched", async () => {
    await putFixtureInBound(SHAPED, "lyrics-uslt.mp3");
    await putFixtureInArchive(KEY, "lyrics-sylt.mp3");

    await poke(T);
    await driveUntilIdle();

    const db = database(testEnv);
    const held = await trackAt(1, SHAPED);
    expect(held?.id).toBe(trackId(1, SHAPED));
    expect(await trackAt(ARCHIVE.id, KEY)).toBeUndefined();
    const [lyrics] = await db
      .select()
      .from(trackLyrics)
      .where(eq(trackLyrics.trackId, held?.id ?? ""));
    expect(lyrics?.text).toBeDefined();
    const libraryOne = await readLastScanSummary(db);
    expect(libraryOne?.libraries["2"]?.broken).toBe(1);
    expect(libraryOne?.libraries["2"]?.indexed).toBe(0);
    const ownLyrics = lyrics?.text ?? "";

    // Remembered at its etag, so a later pass does not read it again, and
    // still writes nothing under the id.
    expect((await readBrokenObjects(db, ARCHIVE.id)).has(KEY)).toBe(true);
    const before = fake.calls.length;
    await poke(LATER);
    await driveUntilIdle();
    expect(operationsSince(fake, before)).not.toContain("GetObject");
    const [again] = await db
      .select()
      .from(trackLyrics)
      .where(eq(trackLyrics.trackId, held?.id ?? ""));
    expect(again?.text).toBe(ownLyrics);
    expect((await trackAt(1, SHAPED))?.libraryId).toBe(1);
  });

  it("is left out of library 1 when library 2 holds the id first", async () => {
    await putFixtureInArchive(KEY, "lyrics-sylt.mp3");
    await poke(T);
    await driveUntilIdle();
    expect(await trackAt(ARCHIVE.id, KEY)).toBeDefined();

    await putFixtureInBound(SHAPED, "lyrics-uslt.mp3");
    await poke(LATER);
    await driveUntilIdle();

    expect(await trackAt(1, SHAPED)).toBeUndefined();
    expect((await trackAt(ARCHIVE.id, KEY))?.id).toBe(trackId(ARCHIVE.id, KEY));
    expect((await readLastScanSummary(database(testEnv)))?.libraries["1"]?.broken).toBe(1);
    expect((await readBrokenObjects(database(testEnv), 1)).has(SHAPED)).toBe(true);
  });
});
