import { library, playlist } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { tallyStatement, utcDay } from "../src/scanner/budget";
import type { ScanDriverTuning } from "../src/scanner/driver";
import { readLastScanSummary } from "../src/scanner/state";
import { StorageError } from "../src/storage/storage";
import { bootstrapAdmin } from "./browsing-support";
import { countingD1 } from "./console-auth-support";
import { driverIsIdle, poke, slowTuning } from "./driver-support";
import { type FakeS3, libraryTestBucket } from "./fake-s3";
import {
  ARCHIVE,
  connectLibrary,
  countedAlarm,
  driveCounted,
  type FakeLibrary,
  installFakeLibrary,
  libraryRow,
  progressNow,
  putFixtureInArchive,
  putInArchive,
  resetLibraries,
  talliedRows,
} from "./scan-libraries-support";
import { seedTrack, testEnv } from "./support";

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
  wrap?: (db: D1Database) => D1Database,
): Promise<{ tallied: number; written: number }> {
  const before = await talliedRows();
  await poke(at, tuning);
  const written = await driveCounted(patch, 80, wrap);
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

/**
 * A D1 that refuses the `refused`-th batch it is sent (counting from 1), as
 * D1 refuses one: atomically, before any of it is written. The count runs
 * across every alarm the wrapper is put in front of.
 */
function refusingBatch(refused: number): {
  wrap: (db: D1Database) => D1Database;
  batches: () => number;
} {
  let batches = 0;
  return {
    batches: () => batches,
    wrap: (db) =>
      new Proxy(db, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop === "batch") {
            return (statements: D1PreparedStatement[]) => {
              batches++;
              return batches === refused
                ? Promise.reject(new Error("D1 refused the batch"))
                : value.call(target, statements);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
  };
}

/** Both libraries as every test here starts them. */
async function seedLibraries(): Promise<void> {
  await resetLibraries();
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
}

beforeEach(async () => {
  installed = installFakeLibrary();
  fake = installed.fake;
  await seedLibraries();
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

    // A third: a track leaves, and its album and artist with it, through
    // the prunes, which write outside the page batches.
    await libraryTestBucket().delete("Silent Artist/Quiet Album/01 Silent Track.mp3");
    const third = await countedPass(new Date(T.getTime() + 120_000));
    const pruned = await readLastScanSummary(database(testEnv));
    expect(pruned?.counts.removed).toBe(1);
    expect(pruned?.counts.albumsRemoved).toBe(1);
    expect(third.tallied).toBe(third.written);
  });
});

describe("a batch D1 refuses", () => {
  /**
   * Refuses each batch of the pass in turn, one pass for each, and checks
   * the tally after the driver's retry: the rows carried when the batch was
   * refused must survive it.
   */
  async function refusingEachBatch(
    seed: () => Promise<void>,
    tuning: ScanDriverTuning = ONE_A_STEP,
  ): Promise<number> {
    await seed();
    const clean = refusingBatch(Number.POSITIVE_INFINITY);
    await countedPass(T, tuning, {}, clean.wrap);
    const batches = clean.batches();

    for (let refused = 1; refused <= batches; refused++) {
      await seed();
      const refusing = refusingBatch(refused);
      const pass = await countedPass(T, tuning, {}, refusing.wrap);
      expect({ refused, tallied: pass.tallied }).toEqual({ refused, tallied: pass.written });
    }

    return batches;
  }

  it("keeps the rows it carried, whichever batch of a pass it is", async () => {
    // One object an import page, so the import commits pages of its own.
    const batches = await refusingEachBatch(seedLibraries, {
      ...ONE_A_STEP,
      playlistLimits: { pageSize: 1 },
    });
    expect(batches).toBeGreaterThan(10);
  }, 180_000);

  it("keeps the rows it carried in the cleanup of a removed library", async () => {
    const removing = async () => {
      await seedLibraries();
      for (let index = 0; index < 3; index++) {
        await seedTrack({ libraryId: ARCHIVE.id, r2Key: `Gone/Album/${index}.mp3` });
      }
      await database(testEnv)
        .update(library)
        .set({ state: "removing" })
        .where(eq(library.id, ARCHIVE.id));
    };
    expect(await refusingEachBatch(removing)).toBeGreaterThan(5);
  }, 180_000);
});

describe("a pass given up on", () => {
  it("tallies the rows its last good step wrote", async () => {
    // After the first step, every lookup of the tracks in a page fails: not
    // a listing, so the driver gives the pass up after its retries.
    let failing = false;
    const wrap = (db: D1Database) =>
      new Proxy(db, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop === "prepare") {
            return (query: string) => {
              if (failing && /from "track"/.test(query)) {
                throw new Error("D1 is down for the tracks");
              }
              return value.call(target, query);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    // The day's tally row exists, as it does after any pass that wrote a
    // track: the give-up's one statement then updates it, a row D1 counts
    // as one (the day's very first tally row is an insert, two: budget.ts).
    const db = database(testEnv);
    await db.batch([tallyStatement(db, utcDay(Date.now()), 0)]);
    const before = await talliedRows();
    await poke(T, ONE_A_STEP);
    const d1 = countingD1(testEnv.DB);
    expect(await countedAlarm(d1, {}, wrap)).toBe(true);
    failing = true;
    for (let alarm = 0; alarm < 10 && (await countedAlarm(d1, {}, wrap)); alarm++) {}

    expect(await driverIsIdle()).toBe(true);
    expect(await progressNow()).not.toBeNull();
    const written = d1.statements.reduce((sum, statement) => sum + statement.rowsWritten, 0);
    expect(written).toBeGreaterThan(0);
    expect((await talliedRows()) - before).toBe(written);
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

describe("a refusal of the import at once, after pages it carried", () => {
  it("tallies the rows its progress row carried, and every other", async () => {
    for (let index = 0; index < 3; index++) {
      await testEnv.MUSIC.put(`Lists/${index}.m3u`, new TextEncoder().encode("#EXTM3U\n"));
    }
    // The import's first page (two objects) lists; the next is refused.
    const music = new Proxy(testEnv.MUSIC, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop === "list") {
          return (options?: R2ListOptions) =>
            options?.limit === 2 && options.cursor !== undefined
              ? Promise.reject(new StorageError("auth", "refused"))
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

    expect((await libraryRow(1))?.lastScanError).toBe("auth");
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
