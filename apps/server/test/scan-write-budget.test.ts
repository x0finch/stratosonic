import { runInDurableObject } from "cloudflare:test";
import { property } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { database } from "../src/db";
import { importPlaylists } from "../src/playlists/import";
import { readPlaylistImportProgress } from "../src/playlists/state";
import {
  budgetReached,
  DEFAULT_SCAN_DAILY_WRITE_BUDGET,
  dailyWriteBudget,
  nextUtcMidnight,
  rowsWrittenOn,
  SCAN_ROWS_WRITTEN_KEY,
  tallyStatement,
  utcDay,
} from "../src/scanner/budget";
import type { ScanDriver } from "../src/scanner/driver";
import { readLastScanSummary } from "../src/scanner/state";
import { bootstrapAdmin } from "./browsing-support";
import {
  driver,
  driverIsIdle,
  driveUntilIdle,
  nextAlarmAt,
  poke,
  runNextAlarm,
  slowTuning,
  storedKeys,
  touch,
} from "./driver-support";
import type { FakeS3 } from "./fake-s3";
import {
  ARCHIVE,
  connectLibrary,
  type FakeLibrary,
  installFakeLibrary,
  progressNow,
  putInArchive,
  resetLibraries,
} from "./scan-libraries-support";
import { testEnv } from "./support";

/**
 * The scan's daily D1 write budget (#84, "Daily D1 write budget (decided)";
 * scanner/budget.ts): the rows a pass writes, progress rows included, are
 * counted per UTC day, and at `SCAN_DAILY_WRITE_BUDGET` the pass ends as a
 * give-up does (no alarm, a pending change kept, the D1 cursor kept) until
 * the next UTC day resumes it. `0` turns the cap off.
 */

const DAY = Date.UTC(2026, 9, 3, 12, 0, 0);
const NEXT_DAY = Date.UTC(2026, 9, 4, 0, 5, 0);
const T = new Date(DAY - 3_600_000);

/** One object a step, so each step writes one progress row. */
const ONE_A_STEP = { ...slowTuning, scanLimits: { pageSize: 1, pagesPerRun: 1 } };

async function tally(): Promise<unknown> {
  const [row] = await database(testEnv)
    .select()
    .from(property)
    .where(eq(property.id, SCAN_ROWS_WRITTEN_KEY));
  return row === undefined ? null : JSON.parse(row.value);
}

beforeAll(async () => {
  await bootstrapAdmin();
});

describe("the tally", () => {
  beforeEach(resetLibraries);

  it("adds a batch's rows to the day's count, and starts a new day afresh", async () => {
    const db = database(testEnv);
    await db.batch([tallyStatement(db, "2026-10-03", 5)]);
    await db.batch([tallyStatement(db, "2026-10-03", 7)]);
    expect(await tally()).toEqual({ day: "2026-10-03", rows: 12 });

    await db.batch([tallyStatement(db, "2026-10-04", 3)]);
    expect(await tally()).toEqual({ day: "2026-10-04", rows: 3 });
  });

  it("replaces a row it cannot read", async () => {
    const db = database(testEnv);
    await db.insert(property).values({ id: SCAN_ROWS_WRITTEN_KEY, value: "{not json" });
    await db.batch([tallyStatement(db, "2026-10-03", 4)]);
    expect(await tally()).toEqual({ day: "2026-10-03", rows: 4 });
  });

  it("counts another day's rows as none", () => {
    expect(rowsWrittenOn({ day: "2026-10-02", rows: 99 }, "2026-10-03")).toBe(0);
    expect(rowsWrittenOn({ day: "2026-10-03", rows: 99 }, "2026-10-03")).toBe(99);
    expect(rowsWrittenOn(null, "2026-10-03")).toBe(0);
  });

  it("names the UTC day, and the midnight that ends it", () => {
    expect(utcDay(Date.UTC(2026, 9, 3, 23, 59, 59))).toBe("2026-10-03");
    expect(nextUtcMidnight(Date.UTC(2026, 9, 3, 23, 59, 59))).toBe(Date.UTC(2026, 9, 4));
    expect(nextUtcMidnight(Date.UTC(2026, 11, 31, 1))).toBe(Date.UTC(2027, 0, 1));
  });
});

describe("SCAN_DAILY_WRITE_BUDGET", () => {
  it("is 50,000 by default, and in wrangler.jsonc", () => {
    expect(DEFAULT_SCAN_DAILY_WRITE_BUDGET).toBe(50_000);
    expect(dailyWriteBudget(testEnv)).toBe(50_000);
  });

  it("reads a whole number, 0 for no cap, and anything else as the default", () => {
    const withBudget = (value: string) => ({ ...testEnv, SCAN_DAILY_WRITE_BUDGET: value });
    expect(dailyWriteBudget(withBudget("1200"))).toBe(1200);
    expect(dailyWriteBudget(withBudget("0"))).toBe(0);
    expect(dailyWriteBudget(withBudget(" 75 "))).toBe(75);
    for (const value of ["", "-5", "1.5", "lots", "1e5"]) {
      expect(dailyWriteBudget(withBudget(value))).toBe(DEFAULT_SCAN_DAILY_WRITE_BUDGET);
    }
  });

  it("is reached at the budget, and never with none", () => {
    expect(budgetReached(9, 10)).toBe(false);
    expect(budgetReached(10, 10)).toBe(true);
    expect(budgetReached(1_000_000, 0)).toBe(false);
  });
});

describe("a pass that reaches the budget", () => {
  let fake: FakeS3;
  let installed: FakeLibrary;

  beforeEach(async () => {
    await resetLibraries();
    installed = installFakeLibrary();
    fake = installed.fake;
    await connectLibrary(fake);
    // Six objects that are not music: every page writes its progress and
    // nothing else, so only the progress rows can reach the budget.
    for (let index = 0; index < 6; index++) {
      await putInArchive(`Notes/${index}.txt`, new Uint8Array([index]));
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DAY);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await driveUntilIdle();
    installed.spy.mockRestore();
  });

  /** Pokes a pass with a budget of four rows and drives it until it stops. */
  async function pausedPass(): Promise<void> {
    await poke(T, { ...ONE_A_STEP, writeBudget: 4 });
    await driveUntilIdle();
  }

  it("counts its progress rows, and pauses at the budget with nothing indexed", async () => {
    await pausedPass();

    // Library 1's empty page stamped it and library 2 (three rows), then
    // one page of library 2: four rows, carried in the progress row.
    const progress = await progressNow();
    expect(progress?.libraryId).toBe(ARCHIVE.id);
    expect(progress?.untallied).toEqual({ day: utcDay(DAY), rows: 4 });
    expect(progress?.counts.examined).toBe(1);
    expect(await readLastScanSummary(database(testEnv))).toBeNull();
  });

  it("stops a step that reaches the budget before its next page", async () => {
    // Ten pages a step would finish both libraries in one step; the budget
    // stops it after library 1's page and library 2's first.
    await poke(T, { ...slowTuning, scanLimits: { pageSize: 1, pagesPerRun: 10 }, writeBudget: 4 });
    await runNextAlarm();

    expect(await driverIsIdle()).toBe(true);
    const progress = await progressNow();
    expect(progress?.libraryId).toBe(ARCHIVE.id);
    expect(progress?.counts.examined).toBe(1);
    expect(await readLastScanSummary(database(testEnv))).toBeNull();
  });

  it("ends like a give-up: no alarm, the driver's storage empty, the D1 cursor kept", async () => {
    await pausedPass();

    expect(await driverIsIdle()).toBe(true);
    expect(await nextAlarmAt()).toBeNull();
    expect((await progressNow())?.cursor).not.toBe("");
  });

  it("keeps a pending change", async () => {
    await poke(T, { ...ONE_A_STEP, writeBudget: 4 });
    await runNextAlarm();
    await touch(Date.now(), { quietMs: 600_000 });
    for (let alarm = 0; alarm < 10 && (await storedKeys()).includes("driver"); alarm++) {
      await runNextAlarm();
    }

    expect(await storedKeys()).toEqual(["pending"]);
    expect(await nextAlarmAt()).toBeNull();

    // The change waits for the next cron poke; this test forgets it.
    await runInDurableObject(driver(), (_instance: ScanDriver, state) => state.storage.deleteAll());
  });

  it("stops a cron poke the same UTC day at its first step, reading nothing", async () => {
    await pausedPass();
    const before = await progressNow();
    const calls = fake.calls.length;

    vi.setSystemTime(DAY + 3_600_000);
    await poke(new Date(DAY + 3_600_000), { ...ONE_A_STEP, writeBudget: 4 });
    await runNextAlarm();

    expect(await driverIsIdle()).toBe(true);
    expect(fake.calls.length).toBe(calls);
    expect(await progressNow()).toEqual(before);
  });

  it("resumes from its cursor on the next UTC day, under its own stamp", async () => {
    await pausedPass();

    vi.setSystemTime(NEXT_DAY);
    await poke(new Date(NEXT_DAY), { ...ONE_A_STEP, writeBudget: 100 });
    await driveUntilIdle();

    const summary = await readLastScanSummary(database(testEnv));
    expect(summary?.startedAt).toBe(T.getTime());
    // The first object was examined on the first day, and not again.
    expect(summary?.libraries["2"]?.examined).toBe(6);
    // Only the new day's rows are on the tally.
    expect(await tally()).toMatchObject({ day: utcDay(NEXT_DAY) });
  });

  it("never pauses with a budget of 0", async () => {
    const db = database(testEnv);
    await db.batch([tallyStatement(db, utcDay(DAY), 10_000_000)]);

    await poke(T, { ...ONE_A_STEP, writeBudget: 0 });
    await driveUntilIdle();

    expect((await readLastScanSummary(db))?.startedAt).toBe(T.getTime());
    expect(await progressNow()).toBeNull();
  });
});

describe("the playlist import at the budget", () => {
  beforeEach(async () => {
    await resetLibraries();
    for (let index = 0; index < 4; index++) {
      await testEnv.MUSIC.put(`Lists/${index}.m3u`, new TextEncoder().encode("#EXTM3U\n"));
    }
  });

  it("counts its progress rows, and pauses at the budget", async () => {
    const limits = { pageSize: 1, importsPerRun: 20, objectsPerRun: 5000 };
    const clock = () => DAY;
    const run = await importPlaylists(testEnv, T, limits, { writeBudget: 2, clock });

    expect(run.paused).toBe(true);
    expect(run.completed).toBe(false);
    const progress = await readPlaylistImportProgress(database(testEnv));
    expect(progress?.untallied).toEqual({ day: utcDay(DAY), rows: 2 });

    // Spent for the day: the next run does nothing.
    const again = await importPlaylists(testEnv, T, limits, { writeBudget: 2, clock });
    expect(again.paused).toBe(true);
    expect(again.counts.examined).toBe(0);

    // The next day it finishes, and puts its rows on the tally.
    const nextDay = await importPlaylists(testEnv, T, limits, {
      writeBudget: 100,
      clock: () => NEXT_DAY,
    });
    expect(nextDay.completed).toBe(true);
    expect(await readPlaylistImportProgress(database(testEnv))).toBeNull();
    expect(await tally()).toMatchObject({ day: utcDay(NEXT_DAY) });
  });
});
