import { playlist } from "@stratosonic/db";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import type { Env } from "../src/env";
import type { ScanDriverTuning } from "../src/scanner/driver";
import { readLastScanSummary } from "../src/scanner/state";
import { StorageError } from "../src/storage/storage";
import { bootstrapAdmin } from "./browsing-support";
import { driverIsIdle, poke, slowTuning } from "./driver-support";
import type { FakeS3 } from "./fake-s3";
import {
  ARCHIVE,
  connectLibrary,
  driveCounted,
  type FakeLibrary,
  installFakeLibrary,
  libraryRow,
  putFixtureInArchive,
  putInArchive,
  resetLibraries,
  talliedRows,
} from "./scan-libraries-support";
import { testEnv } from "./support";

/**
 * The daily write tally counts what D1 wrote (#84, "Daily D1 write budget";
 * scanner/budget.ts), exactly: every pass here runs through the real driver
 * with a D1 that records each statement's `rows_written`, and what the pass
 * added to the tally must equal what D1 reports it wrote, the tally's own
 * writes included. The rows are carried between batches, in progress rows
 * and in the driver's state, so each test ends a pass by a different road:
 * the scan's end after pages that carry and pages that write tracks, a skip
 * of a library in the scan, a skip of the import, and the import's end.
 */

const T = new Date(1_790_000_000_000);
const ONE_A_STEP: ScanDriverTuning = {
  ...slowTuning,
  maxFailures: 2,
  scanLimits: { pageSize: 1, pagesPerRun: 1 },
};

let fake: FakeS3;
let installed: FakeLibrary;

/**
 * Runs a pass through the driver, every statement counted, and answers what
 * it added to the day's tally and what D1 says it wrote.
 */
async function countedPass(
  at: Date,
  tuning: ScanDriverTuning = ONE_A_STEP,
  patch: Partial<Env> = {},
): Promise<{ tallied: number; written: number }> {
  const before = await talliedRows();
  await poke(at, tuning);
  const written = await driveCounted(patch);
  expect(await driverIsIdle()).toBe(true);

  return { tallied: (await talliedRows()) - before, written };
}

/** Library 1's binding, failing the import's listings (500 a page) with `error`. */
function failingImportListing(error: () => Error): Partial<Env> {
  const music = new Proxy(testEnv.MUSIC, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "list") {
        return (options?: R2ListOptions) =>
          options?.limit === 500 ? Promise.reject(error()) : value.call(target, options);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { MUSIC: music };
}

beforeAll(async () => {
  await bootstrapAdmin();
});

beforeEach(async () => {
  await resetLibraries();
  installed = installFakeLibrary();
  fake = installed.fake;
  await connectLibrary(fake);
  // Pages that write only their progress, in both libraries, and tracks in
  // library 2 between them.
  for (let index = 0; index < 3; index++) {
    await testEnv.MUSIC.put(`Notes/${index}.txt`, new Uint8Array([index]));
    await putInArchive(`Notes/${index}.txt`, new Uint8Array([index]));
  }
  await putFixtureInArchive("Silent Artist/Quiet Album/01 Silent Track.mp3", "silent-track.mp3");
  await putFixtureInArchive(
    "Mute Ensemble/Faststart Sessions/01 Front Loaded.m4a",
    "front-loaded.m4a",
  );
});

afterEach(() => {
  fake.fail(null);
  installed.spy.mockRestore();
});

describe("the end of a pass", () => {
  it("tallies every row, after pages that carry them and pages that write tracks", async () => {
    const first = await countedPass(T);
    expect(first.written).toBeGreaterThan(0);
    expect(first.tallied).toBe(first.written);

    // A second pass: unchanged pages, and one that indexes a new track.
    await putFixtureInArchive(
      "Mute Ensemble/Trailing Sessions/01 Tail Loaded.m4a",
      "tail-loaded.m4a",
    );
    const second = await countedPass(new Date(T.getTime() + 60_000));
    const summary = await readLastScanSummary(database(testEnv));
    expect(summary?.counts.added).toBe(1);
    expect(summary?.counts.unchanged).toBe(2);
    expect(second.tallied).toBe(second.written);
  });
});

describe("a skip in the scan", () => {
  it("tallies every row when a library is skipped after its listing kept failing", async () => {
    fake.fail("slow_down", ["ListObjectsV2"]);
    const pass = await countedPass(T);

    expect((await libraryRow(ARCHIVE.id))?.lastScanError).toBe("unavailable");
    expect(pass.tallied).toBe(pass.written);
  });

  it("tallies every row when a library is skipped at once", async () => {
    fake.fail("access_denied");
    const pass = await countedPass(T);

    expect((await libraryRow(ARCHIVE.id))?.lastScanError).toBe("auth");
    expect(pass.tallied).toBe(pass.written);
  });
});

describe("a skip of the import", () => {
  it("tallies every row when the import's listing is refused at once", async () => {
    const pass = await countedPass(
      T,
      ONE_A_STEP,
      failingImportListing(() => new StorageError("auth", "refused")),
    );

    expect((await libraryRow(1))?.lastScanError).toBe("auth");
    expect(pass.tallied).toBe(pass.written);
  });

  it("tallies every row when the import is skipped after its listing kept failing", async () => {
    const pass = await countedPass(
      T,
      ONE_A_STEP,
      failingImportListing(() => new Error("the binding did not answer")),
    );

    expect((await libraryRow(1))?.lastScanError).toBe("unavailable");
    expect(pass.tallied).toBe(pass.written);
  });
});

describe("a skip of the import after pages it carried", () => {
  it("tallies the rows its progress row carried, and every other", async () => {
    for (let index = 0; index < 3; index++) {
      await testEnv.MUSIC.put(`Lists/${index}.m3u`, new TextEncoder().encode("#EXTM3U\n"));
    }
    // The import's first page (two objects) lists; every page after fails.
    const music = new Proxy(testEnv.MUSIC, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === "list") {
          return (options?: R2ListOptions) =>
            options?.limit === 2 && options.cursor !== undefined
              ? Promise.reject(new Error("the binding did not answer"))
              : value.call(target, options);
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const pass = await countedPass(
      T,
      { ...ONE_A_STEP, playlistLimits: { pageSize: 2 } },
      { MUSIC: music },
    );

    expect((await libraryRow(1))?.lastScanError).toBe("unavailable");
    expect(pass.tallied).toBe(pass.written);
  });
});

describe("the end of the import", () => {
  it("tallies every row, the playlists' and their pages' included", async () => {
    for (let index = 0; index < 3; index++) {
      await testEnv.MUSIC.put(
        `Lists/${index}.m3u`,
        new TextEncoder().encode(`#EXTM3U\n../Notes/${index}.txt\n`),
      );
    }
    const pass = await countedPass(T, { ...ONE_A_STEP, playlistLimits: { pageSize: 1 } });

    expect(await database(testEnv).select().from(playlist)).toHaveLength(3);
    expect(pass.tallied).toBe(pass.written);
  });
});
