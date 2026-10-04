import { DEFAULT_LIBRARY_ID, library, property, track } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, type MockInstance } from "vitest";
import { database } from "../src/db";
import { skipLibrary } from "../src/scanner/scan";
import { brokenObjectsKey, readBrokenObjects } from "../src/scanner/state";
import { bootstrapAdmin } from "./browsing-support";
import { driveUntilIdle, poke, runNextAlarm, slowTuning } from "./driver-support";
import { FakeS3, installFakeS3 } from "./fake-s3";
import {
  ARCHIVE,
  connectLibrary,
  libraryRow,
  progressNow,
  putInArchive,
  resetLibraries,
} from "./scan-libraries-support";
import { seedTrack, testEnv } from "./support";

/**
 * The walk from library to library (#84, "Scanning several libraries"),
 * with three libraries: library 1, the bound bucket, and libraries 2 and 3,
 * two R2 buckets behind two fake S3 endpoints. Each library's cursor, sweep
 * position and restart belong to it alone, so leaving a library, for its
 * end or its removal, starts the next one from scratch.
 */

const T = new Date(1_790_000_000_000);
const VINYL = 3;
const ONE_A_STEP = { ...slowTuning, scanLimits: { pageSize: 1, pagesPerRun: 1 } };

let archive: FakeS3;
let vinyl: FakeS3;
let spy: MockInstance<typeof fetch>;

/** Fires alarms until the pass is in library 2, past its first page. */
async function untilInsideLibrary2(): Promise<void> {
  for (let step = 0; step < 10; step++) {
    const progress = await progressNow();
    if (progress?.libraryId === ARCHIVE.id && progress.cursor !== "") {
      return;
    }
    await runNextAlarm();
  }
  throw new Error("the pass never got inside library 2");
}

beforeAll(async () => {
  await bootstrapAdmin();
});

beforeEach(async () => {
  await resetLibraries();
  archive = new FakeS3();
  vinyl = new FakeS3({ accountId: "0123456789abcdef0123456789abcdef", bucket: "vinyl" });
  spy = installFakeS3(archive, vinyl);
  await connectLibrary(archive, ARCHIVE.id);
  await connectLibrary(vinyl, VINYL);
  // Both fakes serve the one test bucket: two objects that are not music.
  await putInArchive("Notes/a.txt", new Uint8Array([1]));
  await putInArchive("Notes/b.txt", new Uint8Array([2]));
});

afterEach(async () => {
  await driveUntilIdle();
  spy.mockRestore();
});

describe("leaving a library at the end of its listing", () => {
  it("starts the next one from scratch: no cursor, no sweep position, no restart", async () => {
    await poke(T, ONE_A_STEP);
    await untilInsideLibrary2();

    // As if library 2's listing had been restarted after a refused cursor.
    const inside = await progressNow();
    expect(inside?.sweptTo).toBe("Notes/a.txt");
    await database(testEnv)
      .update(property)
      .set({ value: JSON.stringify({ ...inside, restarted: true }) })
      .where(eq(property.id, "ScanProgress"));

    // Library 2's last page.
    await runNextAlarm();

    expect(await progressNow()).toMatchObject({
      libraryId: VINYL,
      cursor: "",
      skip: 0,
      sweptTo: "",
      restarted: false,
    });
  });
});

describe("leaving a library removed in the middle of its listing", () => {
  it("starts the next one from scratch, never with the removed one's cursor", async () => {
    await poke(T, ONE_A_STEP);
    await untilInsideLibrary2();

    await database(testEnv)
      .update(library)
      .set({ state: "removing" })
      .where(eq(library.id, ARCHIVE.id));
    await driveUntilIdle();

    const listings = vinyl.calls.filter((call) => call.operation === "ListObjectsV2");
    expect(listings.length).toBeGreaterThan(0);
    expect(listings.every((call) => call.status === 200)).toBe(true);
    expect(new URL(listings[0]?.url ?? "https://x").searchParams.has("continuation-token")).toBe(
      false,
    );
    expect((await libraryRow(VINYL))?.lastScanError).toBeNull();
    expect(await libraryRow(ARCHIVE.id)).toBeUndefined();
  });
});

describe("skipping a library the pass is not in", () => {
  it("changes nothing", async () => {
    await testEnv.MUSIC.put("Notes/one.txt", new Uint8Array([1]));
    await testEnv.MUSIC.put("Notes/two.txt", new Uint8Array([2]));
    await poke(T, ONE_A_STEP);
    await runNextAlarm();
    const before = await progressNow();
    expect(before?.libraryId).toBe(DEFAULT_LIBRARY_ID);

    await skipLibrary(testEnv, T, ARCHIVE.id, "unavailable");

    expect(await progressNow()).toEqual(before);
    expect((await libraryRow(ARCHIVE.id))?.lastScanError).toBeNull();
  });
});

describe("library 1 marked removing", () => {
  it("is never cleaned up: the bound bucket's library cannot be removed", async () => {
    const kept = await seedTrack({ r2Key: "Kept Artist/Kept Album/01 Kept.mp3" });
    await database(testEnv)
      .update(library)
      .set({ state: "removing" })
      .where(eq(library.id, DEFAULT_LIBRARY_ID));

    await poke(T, ONE_A_STEP);
    await driveUntilIdle();

    expect(await libraryRow(DEFAULT_LIBRARY_ID)).toBeDefined();
    const [row] = await database(testEnv).select().from(track).where(eq(track.id, kept.id));
    expect(row).toBeDefined();
  });
});

describe("the memo of broken objects", () => {
  it("keeps v0.5.0's key for library 1, and a key of its own for every other", async () => {
    expect(brokenObjectsKey(DEFAULT_LIBRARY_ID)).toBe("BrokenObjects");
    expect(brokenObjectsKey(ARCHIVE.id)).toBe("BrokenObjects:2");

    // A memo v0.5.0 wrote is library 1's.
    await database(testEnv)
      .insert(property)
      .values({ id: "BrokenObjects", value: JSON.stringify({ "x.mp3": "etag-x" }) });
    expect((await readBrokenObjects(database(testEnv), DEFAULT_LIBRARY_ID)).get("x.mp3")).toBe(
      "etag-x",
    );
    expect((await readBrokenObjects(database(testEnv), ARCHIVE.id)).size).toBe(0);
  });
});
