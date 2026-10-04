import { runInDurableObject } from "cloudflare:test";
import { library, playlist, property } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { importPlaylists, skipPlaylistLibrary } from "../src/playlists/import";
import { readPlaylistImportProgress } from "../src/playlists/state";
import type { ScanDriver } from "../src/scanner/driver";
import { LibraryListingError } from "../src/scanner/listing-failure";
import { runScan } from "../src/scanner/scan";
import { readBrokenObjects, readLastScanSummary } from "../src/scanner/state";
import { bootstrapAdmin } from "./browsing-support";
import {
  driver,
  driverIsIdle,
  driveUntilIdle,
  poke,
  runNextAlarm,
  slowTuning,
} from "./driver-support";
import type { FakeS3, FakeS3Failure } from "./fake-s3";
import { fixtures } from "./fixtures/files";
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
  resetLibraries,
  trackAt,
  tracksIn,
} from "./scan-libraries-support";
import { seedFixtureObject, testEnv } from "./support";

/**
 * Skipping a library (#84, "Skipping a library"): only a failed listing
 * judges a library, and nothing is swept from one that was not listed.
 * Library 2 sits behind the fake S3 endpoint, which is switched to fail as
 * R2 fails: a refused key (403), throttling (503 `SlowDown`), an outage, a
 * dropped connection, a refused continuation token and a listing without
 * its `<EncodingType>` echo.
 */

const SILENT = "Silent Artist/Quiet Album/01 Silent Track.mp3";
const FRONT = "Mute Ensemble/Faststart Sessions/01 Front Loaded.m4a";
const TAIL = "Mute Ensemble/Trailing Sessions/01 Tail Loaded.m4a";
const UNTAGGED = "Fallback Artist/Fallback Album/01 Untagged.mp3";
const NEW_IN_ONE = "Silent Artist/Quiet Album/02 Hushed Interlude.flac";

const T = new Date(1_790_000_000_000);
const LATER = new Date(T.getTime() + 3_600_000);

/** Retries that fit a test: three failures, then the skip. */
const RETRYING = { ...slowTuning, maxFailures: 3 };

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
  fake.fail(null);
  await driveUntilIdle();
  installed.spy.mockRestore();
});

/** Library 2 with three tracks, library 1 with one, both indexed at `T`. */
async function indexedLibraries(): Promise<string[]> {
  await putFixtureInBound(UNTAGGED, "untagged.mp3");
  await putFixtureInArchive(SILENT, "silent-track.mp3");
  await putFixtureInArchive(FRONT, "front-loaded.m4a");
  await putFixtureInArchive(TAIL, "tail-loaded.m4a");
  await poke(T);
  await driveUntilIdle();

  const ids = (await tracksIn(ARCHIVE.id)).map((row) => row.id);
  expect(ids).toHaveLength(3);
  return ids;
}

describe("a key the bucket refuses (403)", () => {
  let before: number;
  let archived: string[];

  beforeEach(async () => {
    archived = await indexedLibraries();
    await putFixtureInBound(NEW_IN_ONE, "hushed-interlude.flac");
    await seedFixtureObject(fixtures.playlist.file);

    fake.fail("access_denied");
    before = fake.calls.length;
    await poke(LATER, RETRYING);
    await driveUntilIdle();
  });

  it("skips library 2 at once, with auth, and no retry, in the scan and the import", async () => {
    // One listing each: the scan's, and the playlist import's (#150).
    expect(operationsSince(fake, before)).toEqual(["ListObjectsV2", "ListObjectsV2"]);
    const row = await libraryRow(ARCHIVE.id);
    expect(row?.lastScanError).toBe("auth");
    // Entered by this pass, left by the last good one.
    expect(row?.lastScanStartedAt?.getTime()).toBe(LATER.getTime());
    expect(row?.lastScanAt?.getTime()).toBe(T.getTime());
  });

  it("keeps every library-2 track", async () => {
    expect((await tracksIn(ARCHIVE.id)).map((row) => row.id)).toEqual(archived);
  });

  it("completes library 1 and the playlist phase", async () => {
    expect(await trackAt(1, NEW_IN_ONE)).toBeDefined();
    const summary = await readLastScanSummary(database(testEnv));
    expect(summary?.startedAt).toBe(LATER.getTime());
    expect(summary?.counts.removed).toBe(0);
    const playlists = await database(testEnv).select().from(playlist);
    expect(playlists.map((row) => row.r2Key)).toEqual([fixtures.playlist.r2Key]);
    expect(await readPlaylistImportProgress(database(testEnv))).toBeNull();
    expect(await driverIsIdle()).toBe(true);
  });

  it("is cleared by a later pass that lists the library", async () => {
    fake.fail(null);
    await poke(new Date(LATER.getTime() + 60_000));
    await driveUntilIdle();

    const row = await libraryRow(ARCHIVE.id);
    expect(row?.lastScanError).toBeNull();
    expect(row?.lastScanAt?.getTime()).toBe(LATER.getTime() + 60_000);
    expect((await tracksIn(ARCHIVE.id)).map((row) => row.id)).toEqual(archived);
  });
});

describe("a refused key, inside one step", () => {
  it("skips library 2 within the step that met it: no failure for the driver to retry", async () => {
    await putFixtureInBound(UNTAGGED, "untagged.mp3");
    await putFixtureInArchive(SILENT, "silent-track.mp3");
    fake.fail("access_denied");

    const run = await runScan(testEnv, T, {
      pageSize: 90,
      pagesPerRun: 3,
      extractionsPerRun: 6,
      deletionsPerPage: 90,
    });

    // Library 1 listed, library 2 skipped, the prune run: all in one step.
    expect(run.completed).toBe(true);
    expect((await libraryRow(ARCHIVE.id))?.lastScanError).toBe("auth");
    expect(await trackAt(1, UNTAGGED)).toBeDefined();
  });
});

describe("a bucket that is gone (NoSuchBucket)", () => {
  it("is skipped at once with bucket_not_found, its tracks kept", async () => {
    const archived = await indexedLibraries();
    fake.fail("no_such_bucket");
    const before = fake.calls.length;
    await poke(LATER, RETRYING);
    await driveUntilIdle();

    // The scan's listing, then the playlist import's.
    expect(operationsSince(fake, before)).toEqual(["ListObjectsV2", "ListObjectsV2"]);
    expect((await libraryRow(ARCHIVE.id))?.lastScanError).toBe("bucket_not_found");
    expect((await tracksIn(ARCHIVE.id)).map((row) => row.id)).toEqual(archived);
  });
});

describe.each<[string, FakeS3Failure]>([
  ["503 SlowDown", "slow_down"],
  ["a 500", "server_error"],
  ["a dropped connection", "network"],
  ["a listing without its <EncodingType> echo", "no_encoding_echo"],
])("a listing that fails with %s", (_name, failure) => {
  let before: number;
  let archived: string[];

  beforeEach(async () => {
    archived = await indexedLibraries();
    fake.fail(failure, ["ListObjectsV2"]);
    before = fake.calls.length;
    await poke(LATER, RETRYING);
    await driveUntilIdle();
  });

  it("is retried, then library 2 is skipped as unavailable, by the scan and the import", async () => {
    // Three tries in the scan, then three in the playlist import (#150).
    expect(operationsSince(fake, before)).toEqual(Array(6).fill("ListObjectsV2"));
    expect((await libraryRow(ARCHIVE.id))?.lastScanError).toBe("unavailable");
  });

  it("sweeps nothing from library 2, and the pass completes", async () => {
    expect((await tracksIn(ARCHIVE.id)).map((row) => row.id)).toEqual(archived);
    const summary = await readLastScanSummary(database(testEnv));
    expect(summary?.startedAt).toBe(LATER.getTime());
    expect(summary?.counts.removed).toBe(0);
    expect(await driverIsIdle()).toBe(true);
  });
});

describe("a continuation token the bucket refuses (invalid_cursor)", () => {
  /** Runs the pass until it is in library 2 with a cursor, then spoils it. */
  async function spoilTheCursor(restarted: boolean): Promise<void> {
    await putFixtureInArchive(SILENT, "silent-track.mp3");
    await putFixtureInArchive(FRONT, "front-loaded.m4a");
    await putFixtureInArchive(TAIL, "tail-loaded.m4a");
    await putFixtureInArchive(UNTAGGED, "untagged.mp3");
    await poke(T, { ...RETRYING, scanLimits: { pageSize: 1, pagesPerRun: 1 } });
    for (let step = 0; step < 10; step++) {
      const progress = await progressNow();
      if (progress?.libraryId === ARCHIVE.id && progress.cursor !== "") {
        break;
      }
      await runNextAlarm();
    }
    const progress = await progressNow();
    expect(progress?.libraryId).toBe(ARCHIVE.id);
    await database(testEnv)
      .update(property)
      .set({ value: JSON.stringify({ ...progress, cursor: "a token never issued", restarted }) })
      .where(eq(property.id, "ScanProgress"));
  }

  it("restarts library 2's listing from its start, and sweeps nothing", async () => {
    await spoilTheCursor(false);
    const before = fake.calls.length;
    await driveUntilIdle();

    const lists = fake.calls.slice(before).filter((call) => call.operation === "ListObjectsV2");
    expect(lists[0]?.status).toBe(400);
    expect(new URL(lists[1]?.url ?? "https://x").searchParams.has("continuation-token")).toBe(
      false,
    );
    expect((await libraryRow(ARCHIVE.id))?.lastScanError).toBeNull();
    expect(await tracksIn(ARCHIVE.id)).toHaveLength(4);
    const summary = await readLastScanSummary(database(testEnv));
    expect(summary?.libraries["2"]?.removed).toBe(0);
  });

  it("restarts it only once: a second refusal is retried, then skipped", async () => {
    await spoilTheCursor(true);
    const held = (await tracksIn(ARCHIVE.id)).map((row) => row.id);
    await driveUntilIdle();

    expect((await libraryRow(ARCHIVE.id))?.lastScanError).toBe("unavailable");
    expect((await tracksIn(ARCHIVE.id)).map((row) => row.id)).toEqual(held);
  });

  it("is a listing failure the driver can skip, when it comes again", async () => {
    await spoilTheCursor(true);
    await expect(
      runScan(testEnv, T, {
        pageSize: 1,
        pagesPerRun: 1,
        extractionsPerRun: 6,
        deletionsPerPage: 90,
      }),
    ).rejects.toMatchObject({
      name: "LibraryListingError",
      libraryId: ARCHIVE.id,
      reason: "unavailable",
    });
    await runInDurableObject(driver(), async (_instance: ScanDriver, state) => {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
    });
  });
});

describe("a failed read of one object", () => {
  it("defers only that object, and the library is still listed and swept", async () => {
    await putFixtureInArchive(SILENT, "silent-track.mp3");
    await putFixtureInArchive(FRONT, "front-loaded.m4a");
    fake.fail("server_error", ["GetObject"], [FRONT]);
    await poke(T);
    await driveUntilIdle();

    expect(await trackAt(ARCHIVE.id, SILENT)).toBeDefined();
    expect(await trackAt(ARCHIVE.id, FRONT)).toBeUndefined();
    const summary = await readLastScanSummary(database(testEnv));
    expect(summary?.libraries["2"]?.deferred).toBe(1);
    expect(summary?.libraries["2"]?.broken).toBe(0);
    expect((await libraryRow(ARCHIVE.id))?.lastScanError).toBeNull();
    expect((await readBrokenObjects(database(testEnv), ARCHIVE.id)).size).toBe(0);

    fake.fail(null);
    await poke(LATER);
    await driveUntilIdle();
    expect(await trackAt(ARCHIVE.id, FRONT)).toBeDefined();
  });
});

describe("keys a path-style URL cannot carry", () => {
  const DOTTED = "Dots/../01 Dotted.mp3";
  const SINGLE = "Dots/./02 Single.mp3";
  const ENCODED = "Dots/%2e/03 Encoded.mp3";

  it("counts a key with a literal . or .. segment broken, without requesting it", async () => {
    await putFixtureInArchive(DOTTED, "silent-track.mp3");
    await putFixtureInArchive(SINGLE, "silent-track.mp3");
    await poke(T);
    await driveUntilIdle();

    const requested = fake.calls
      .filter((call) => call.operation !== "ListObjectsV2")
      .map((call) => call.key);
    expect(requested).toEqual([]);
    expect(await tracksIn(ARCHIVE.id)).toEqual([]);
    const memo = await readBrokenObjects(database(testEnv), ARCHIVE.id);
    expect([...memo.keys()].sort()).toEqual([DOTTED, SINGLE].sort());
    expect((await readLastScanSummary(database(testEnv)))?.libraries["2"]?.broken).toBe(2);
  });

  it("reads a key with a %2e segment, which is an ordinary name", async () => {
    await putFixtureInArchive(ENCODED, "silent-track.mp3");
    await poke(T);
    await driveUntilIdle();

    expect(fake.calls.some((call) => call.operation === "GetObject" && call.key === ENCODED)).toBe(
      true,
    );
    expect(await trackAt(ARCHIVE.id, ENCODED)).toBeDefined();
  });
});

describe("a library set removing while the pass is in it", () => {
  it("is left at the next step: not listed, not read, not swept", async () => {
    await putFixtureInBound(UNTAGGED, "untagged.mp3");
    await putFixtureInArchive(SILENT, "silent-track.mp3");
    await putFixtureInArchive(FRONT, "front-loaded.m4a");
    await putFixtureInArchive(TAIL, "tail-loaded.m4a");
    await poke(T, { ...slowTuning, scanLimits: { pageSize: 1, pagesPerRun: 1 } });
    for (let step = 0; step < 10; step++) {
      const progress = await progressNow();
      if (progress?.libraryId === ARCHIVE.id && progress.cursor !== "") {
        break;
      }
      await runNextAlarm();
    }
    expect((await progressNow())?.libraryId).toBe(ARCHIVE.id);

    await database(testEnv)
      .update(library)
      .set({ state: "removing" })
      .where(eq(library.id, ARCHIVE.id));
    const before = fake.calls.length;
    await driveUntilIdle();

    expect(fake.calls.length).toBe(before);
    const summary = await readLastScanSummary(database(testEnv));
    expect(summary?.startedAt).toBe(T.getTime());
    expect(summary?.counts.removed).toBe(0);
    expect(summary?.libraries["2"]?.removed ?? 0).toBe(0);
    expect(await trackAt(1, UNTAGGED)).toBeDefined();
  });
});

describe("a library in a state this version does not know", () => {
  it("is neither scanned nor cleaned up: only active libraries are listed", async () => {
    const archived = await indexedLibraries();
    // `state` carries no CHECK (packages/db): a later release may add one.
    await database(testEnv)
      .update(library)
      .set({ state: "suspended" as never })
      .where(eq(library.id, ARCHIVE.id));
    const before = fake.calls.length;
    await poke(LATER);
    await driveUntilIdle();

    expect(fake.calls.length).toBe(before);
    expect((await tracksIn(ARCHIVE.id)).map((row) => row.id)).toEqual(archived);
    expect((await libraryRow(ARCHIVE.id))?.state).toBe("suspended");
    expect((await readLastScanSummary(database(testEnv)))?.startedAt).toBe(LATER.getTime());
  });
});

describe("the playlist import's listing", () => {
  /** Library 1's binding, failing every listing the import makes. */
  function failingImportEnv(): Env {
    const music = new Proxy(testEnv.MUSIC, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === "list") {
          return (options?: R2ListOptions) =>
            options?.limit === 500
              ? Promise.reject(new Error("the binding did not answer"))
              : value.call(target, options);
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { ...testEnv, MUSIC: music };
  }

  it("is a listing failure of library 1, read as unavailable through the binding", async () => {
    await expect(importPlaylists(failingImportEnv(), T)).rejects.toBeInstanceOf(
      LibraryListingError,
    );
    await expect(importPlaylists(failingImportEnv(), T)).rejects.toMatchObject({
      libraryId: 1,
      reason: "unavailable",
    });
  });

  it("is retried by the driver, then library 1's import is skipped and the pass ends", async () => {
    await putFixtureInBound(UNTAGGED, "untagged.mp3");
    await poke(T, RETRYING);

    // The alarms run with the failing binding, as the driver's own env.
    for (let alarm = 0; alarm < 10 && !(await driverIsIdle()); alarm++) {
      await runInDurableObject(driver(), async (instance: ScanDriver, state) => {
        const self = instance as unknown as { env: Env };
        const original = self.env;
        self.env = failingImportEnv();
        try {
          await state.storage.deleteAlarm();
          await instance.alarm();
        } finally {
          self.env = original;
        }
      });
    }

    expect(await driverIsIdle()).toBe(true);
    expect(await trackAt(1, UNTAGGED)).toBeDefined();
    expect((await libraryRow(1))?.lastScanError).toBe("unavailable");
    expect(await readPlaylistImportProgress(database(testEnv))).toBeNull();
  });

  it("skips with one batch: the error, and the import moved to the next library", async () => {
    expect(await skipPlaylistLibrary(testEnv, T, 1, "unavailable")).toEqual({ completed: false });
    expect((await libraryRow(1))?.lastScanError).toBe("unavailable");
    expect(await readPlaylistImportProgress(database(testEnv))).toMatchObject({
      libraryId: ARCHIVE.id,
      cursor: "",
      startedAt: T.getTime(),
    });
  });

  it("ends the import's pass when it skips the last library", async () => {
    await skipPlaylistLibrary(testEnv, T, 1, "unavailable");
    expect(await skipPlaylistLibrary(testEnv, T, ARCHIVE.id, "throttled")).toEqual({
      completed: true,
    });
    expect((await libraryRow(ARCHIVE.id))?.lastScanError).toBe("throttled");
    expect(await readPlaylistImportProgress(database(testEnv))).toBeNull();
  });

  it("leaves a pass that has already left the library alone", async () => {
    await skipPlaylistLibrary(testEnv, T, 1, "unavailable");
    expect(await skipPlaylistLibrary(testEnv, T, 1, "unavailable")).toEqual({ completed: false });
    expect((await readPlaylistImportProgress(database(testEnv)))?.libraryId).toBe(ARCHIVE.id);
  });
});
