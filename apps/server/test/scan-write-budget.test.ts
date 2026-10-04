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
  WORST_ROWS_PER_INDEXED_TRACK,
} from "../src/scanner/budget";
import type { ScanDriver } from "../src/scanner/driver";
import { readLastScanSummary } from "../src/scanner/state";
import { bootstrapAdmin, browse } from "./browsing-support";
import { countingD1 } from "./console-auth-support";
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
  driveCounted,
  type FakeLibrary,
  installFakeLibrary,
  progressNow,
  putInArchive,
  resetLibraries,
  talliedRows,
} from "./scan-libraries-support";
import { testEnv } from "./support";

/**
 * The scan's daily D1 write budget (#84, "Daily D1 write budget (decided)";
 * scanner/budget.ts): the rows a pass writes, progress rows included, are
 * counted per UTC day, and at `SCAN_DAILY_WRITE_BUDGET` the pass ends as a
 * give-up does (no alarm, a pending change kept, the D1 cursor kept) until
 * the next UTC day resumes it. `0` turns the cap off.
 */

// In the future, so no alarm a pass sets under the fake clock is already
// due by the real one, which miniflare would fire by itself.
const DAY = Date.UTC(2030, 0, 15, 12, 0, 0);
const NEXT_DAY = Date.UTC(2030, 0, 16, 0, 5, 0);
const T = new Date(DAY - 3_600_000);

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
  /** The budget these passes run with, and the room a page of one object reserves. */
  const BUDGET = 1000;
  const HEADROOM = WORST_ROWS_PER_INDEXED_TRACK;
  const tuning = (pagesPerRun: number, writeBudget = BUDGET) => ({
    ...slowTuning,
    scanLimits: { pageSize: 1, pagesPerRun },
    writeBudget,
  });

  let fake: FakeS3;
  let installed: FakeLibrary;

  beforeEach(async () => {
    await resetLibraries();
    installed = installFakeLibrary();
    fake = installed.fake;
    await connectLibrary(fake);
    // Forty objects that are not music: every page writes its progress and
    // nothing else.
    for (let index = 0; index < 40; index++) {
      await putInArchive(`Notes/${String(index).padStart(2, "0")}.txt`, new Uint8Array([index]));
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DAY);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await driveUntilIdle();
    installed.spy.mockRestore();
  });

  /** Puts `rows` on today's tally, as earlier passes would have. */
  async function spent(rows: number): Promise<void> {
    const db = database(testEnv);
    await db.batch([tallyStatement(db, utcDay(DAY), rows)]);
  }

  /** A pass that starts 50 rows short of the budget, driven until it stops. */
  async function pausedPass(): Promise<number> {
    await spent(BUDGET - 50);
    await poke(T, tuning(3));
    return driveCounted();
  }

  it("tallies what D1 wrote, and pauses before a page that could overshoot", async () => {
    const written = await pausedPass();

    // On the tally, and carried for it in the paused pass's progress row.
    const progress = await progressNow();
    const rows = (await talliedRows()) + (progress?.untallied?.rows ?? 0);
    expect(rows).toBe(BUDGET - 50 + written);
    expect(rows).toBeLessThan(BUDGET);
    expect(rows + HEADROOM).toBeGreaterThanOrEqual(BUDGET);
    expect(progress?.libraryId).toBe(ARCHIVE.id);
    expect(progress?.counts.examined).toBeGreaterThan(0);
    expect(progress?.counts.examined).toBeLessThan(40);
    expect(await readLastScanSummary(database(testEnv))).toBeNull();
  });

  it("stops a step that reaches the budget before its next page", async () => {
    // Ten pages a step would carry on into library 2; the budget leaves room
    // for library 1's (empty) page and no more.
    await spent(BUDGET - HEADROOM - 1);
    await poke(T, tuning(10));
    await runNextAlarm();

    expect(await driverIsIdle()).toBe(true);
    const progress = await progressNow();
    expect(progress?.libraryId).toBe(ARCHIVE.id);
    expect(progress?.counts.examined).toBe(0);
  });

  it("ends like a give-up: no alarm, the driver's storage empty, the D1 cursor kept", async () => {
    await pausedPass();

    expect(await driverIsIdle()).toBe(true);
    expect(await nextAlarmAt()).toBeNull();
    expect((await progressNow())?.cursor).not.toBe("");
  });

  it("keeps a pending change", async () => {
    await spent(BUDGET - 50);
    await poke(T, tuning(3));
    await runNextAlarm();
    await touch(Date.now(), { quietMs: 600_000 });
    for (let alarm = 0; alarm < 40 && (await storedKeys()).includes("driver"); alarm++) {
      await runNextAlarm();
    }

    expect(await storedKeys()).toEqual(["pending"]);
    expect(await nextAlarmAt()).toBeNull();

    // The change waits for the next cron poke; this test forgets it.
    await runInDurableObject(driver(), (_instance: ScanDriver, state) => state.storage.deleteAll());
  });

  it("reads as no scan in getScanStatus while it is paused, its cursor waiting", async () => {
    await pausedPass();
    expect(await progressNow()).not.toBeNull();
    const scanning = async () =>
      ((await browse("getScanStatus")) as unknown as { scanStatus?: { scanning: boolean } })
        .scanStatus?.scanning;

    // Under the deployment's own budget (50,000), the pass reads as running,
    // as a given-up one does until the next cron poke resumes it.
    expect(await scanning()).toBe(true);

    // Over it, the day's passes are paused.
    await spent(50_000);
    expect(await scanning()).toBe(false);
  });

  it("stops a cron poke the same UTC day at its first step, reading nothing", async () => {
    await pausedPass();
    const before = await progressNow();
    const calls = fake.calls.length;

    vi.setSystemTime(DAY + 3_600_000);
    await poke(new Date(DAY + 3_600_000), tuning(3));
    await runNextAlarm();

    expect(await driverIsIdle()).toBe(true);
    expect(fake.calls.length).toBe(calls);
    expect(await progressNow()).toEqual(before);
  });

  it("resumes from its cursor on the next UTC day, under its own stamp", async () => {
    await pausedPass();

    vi.setSystemTime(NEXT_DAY);
    await poke(new Date(NEXT_DAY), tuning(3, 100_000));
    const written = await driveCounted();

    const summary = await readLastScanSummary(database(testEnv));
    expect(summary?.startedAt).toBe(T.getTime());
    // Every object examined once, over the two days.
    expect(summary?.libraries["2"]?.examined).toBe(40);
    // Only the new day's rows are on the new day's tally.
    expect(await tally()).toEqual({ day: utcDay(NEXT_DAY), rows: written });
  });

  it("never pauses with a budget of 0", async () => {
    await spent(10_000_000);

    await poke(T, tuning(10, 0));
    await driveUntilIdle();

    expect((await readLastScanSummary(database(testEnv)))?.startedAt).toBe(T.getTime());
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

  it("tallies what D1 wrote, its playlists' rows included, and pauses at the budget", async () => {
    const db = database(testEnv);
    await db.batch([tallyStatement(db, utcDay(DAY), 999)]);
    const d1 = countingD1(testEnv.DB);
    const env = { ...testEnv, DB: d1.binding };
    const limits = { pageSize: 1, importsPerRun: 20, objectsPerRun: 5000, subrequestsPerRun: 42 };
    const clock = () => DAY;

    const run = await importPlaylists(env, T, limits, { writeBudget: 1000, clock });
    const written = d1.statements.reduce((sum, statement) => sum + statement.rowsWritten, 0);

    expect(run.paused).toBe(true);
    expect(run.counts.imported).toBe(1);
    // On the tally, and carried for it in the paused import's progress row.
    const progress = await readPlaylistImportProgress(db);
    expect(progress).not.toBeNull();
    expect(((await tally()) as { rows: number }).rows + (progress?.untallied?.rows ?? 0)).toBe(
      999 + written,
    );

    // Spent for the day: the next run does nothing.
    const again = await importPlaylists(testEnv, T, limits, { writeBudget: 1000, clock });
    expect(again.paused).toBe(true);
    expect(again.counts.examined).toBe(0);

    // The next day it finishes, and puts every row it wrote on the tally.
    d1.reset();
    const nextDay = await importPlaylists(env, T, limits, {
      writeBudget: 1000,
      clock: () => NEXT_DAY,
    });
    const nextWritten = d1.statements.reduce((sum, statement) => sum + statement.rowsWritten, 0);
    expect(nextDay.completed).toBe(true);
    expect(await readPlaylistImportProgress(db)).toBeNull();
    expect(await tally()).toEqual({ day: utcDay(NEXT_DAY), rows: nextWritten });
  });
});
