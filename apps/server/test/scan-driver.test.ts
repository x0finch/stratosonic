import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import worker from "../src/index";
import { DEFAULT_SCAN_LIMITS } from "../src/scanner/scan";
import { readLastScanSummary, readScanProgress, type ScanProgress } from "../src/scanner/state";
import type { BrowsingResponse } from "./browsing-support";
import { bootstrapAdmin, browse } from "./browsing-support";
import {
  driverIsIdle,
  driveUntilIdle,
  nextAlarmAt,
  poke,
  pokeDuringAStep,
  runNextAlarm,
  slowTuning,
} from "./driver-support";
import { fixtures } from "./fixtures/files";
import { playlists } from "./playlists-support";
import { resetLibrary, seedFixtureFiles } from "./scan-support";
import { testEnv } from "./support";

/**
 * The scan driver (#31): the Durable Object whose alarm carries a pass to
 * completion instead of one step per cron tick.
 *
 * Everything here goes through the real seams. The bucket is seeded, the
 * cron entry is invoked exactly as the runtime invokes it, the Durable
 * Object is the one the binding creates - not a stand-in - and what a pass
 * produced is read back through the `fetch` handler, as every other test in
 * this suite reads the library. The only things asserted about the driver
 * itself are what the platform holds on its behalf: whether an alarm is
 * scheduled and when it is due. The failure counter is never read; it is
 * observed through the delays it produces, which is what it is for.
 */

/** The cron that carries the poke in production, from wrangler.jsonc. */
const CRON = "*/15 * * * *";

/** The instant the first cron run is stamped with. */
const FIRST_POKE = new Date(1_750_000_000_000);

/** How far apart the passes in this file are. */
const QUARTER_HOUR = 15 * 60_000;

/** One cron invocation: the real `scheduled` export, as the runtime calls it. */
async function runScheduled(now: Date): Promise<void> {
  const controller: ScheduledController = {
    scheduledTime: now.getTime(),
    cron: CRON,
    noRetry() {
      // A cron run that fails is not retried; the next one pokes again.
    },
  };

  await worker.scheduled(controller, testEnv);
}

/** The artists of `getArtists`, flattened out of their index buckets. */
function artistNames(body: BrowsingResponse): string[] {
  return (body.artists?.index ?? []).flatMap((index) => index.artist).map((artist) => artist.name);
}

/** Every artist the fixtures describe, in the order `getArtists` sorts them. */
function fixtureArtists(): string[] {
  return [...new Set(fixtures.albums.map((album) => album.albumArtist))].sort();
}

/** What the completed pass recorded, or a failure naming what it left instead. */
async function completedPass() {
  const db = database(testEnv);
  const summary = await readLastScanSummary(db);
  if (summary === null) {
    throw new Error(`no pass completed; progress ${JSON.stringify(await readScanProgress(db))}`);
  }

  return summary;
}

/** Asserts the whole fixture library is there, as a client sees it. */
async function expectWholeLibrary(): Promise<void> {
  expect(artistNames(await browse("getArtists")).sort()).toEqual(fixtureArtists());

  const imported = (await playlists("getPlaylists")).playlists?.playlist ?? [];
  expect(imported.map((entry) => entry.name)).toEqual([fixtures.playlist.name]);
}

/* ================================================ the cron poke == */

describe("a cron poke driving a pass through chained alarms", () => {
  /** What the scan had written by the time the poke returned. */
  let afterPoke: ScanProgress | null = null;
  let scannedAfterPoke = true;
  let alarms = 0;

  beforeAll(async () => {
    await bootstrapAdmin();
    await seedFixtureFiles();

    await runScheduled(FIRST_POKE);
    // Read before the first alarm is due: the poke must arm the driver and
    // nothing else, because a cron invocation has 10 ms of CPU to do it in.
    afterPoke = await readScanProgress(database(testEnv));
    scannedAfterPoke = (await readLastScanSummary(database(testEnv))) !== null;

    alarms = await driveUntilIdle();
  });

  it("scans nothing in the cron invocation itself", () => {
    expect(afterPoke).toBeNull();
    expect(scannedAfterPoke).toBe(false);
  });

  it("indexes the library and imports the playlist through the alarms alone", async () => {
    await expectWholeLibrary();
  });

  it("stamps the pass with the cron's scheduled time", async () => {
    const summary = await completedPass();

    expect(summary.startedAt).toBe(FIRST_POKE.getTime());
    expect(summary.counts.indexed).toBe(fixtures.tracks.length);
    expect(summary.counts.broken).toBe(0);
    // The scan itself counts its steps, so this says how many the pass took
    // whoever fired the alarms.
    expect(summary.counts.steps).toBe(1);
  });

  it("takes one alarm for the scan and one for the import, then stops", async () => {
    // Five fixtures is fewer than one step may read, so the scan's pass ends
    // in its first step and the import has the second. The scan's own step
    // count is the exact one; the alarms this test fired are an upper bound,
    // because miniflare fires a due alarm of its own accord as well.
    expect(fixtures.tracks.length).toBeLessThanOrEqual(DEFAULT_SCAN_LIMITS.extractionsPerRun);
    expect((await completedPass()).counts.steps).toBe(1);
    expect(alarms).toBeLessThanOrEqual(2);

    // And having done them, the driver stops: no alarm is left scheduled,
    // and its storage is empty.
    expect(await nextAlarmAt()).toBeNull();
    expect(await driverIsIdle()).toBe(true);
  });

  it("starts a fresh pass when the next cron poke arrives", async () => {
    const secondPoke = new Date(FIRST_POKE.getTime() + QUARTER_HOUR);

    expect(await poke(secondPoke)).toBe("started");
    await driveUntilIdle();

    expect((await completedPass()).startedAt).toBe(secondPoke.getTime());
    await expectWholeLibrary();
  });
});

/* ======================================== a pass of several steps == */

describe("a pass whose scan does not fit in one step", () => {
  const poked = new Date(FIRST_POKE.getTime() + 2 * QUARTER_HOUR);
  let alarms = 0;

  beforeAll(async () => {
    await resetLibrary();
    await seedFixtureFiles();

    // Two tracks a step, so the five fixtures need three scan steps and the
    // import needs a fourth. `DEFAULT_SCAN_LIMITS` is untouched: what the
    // driver is given is a smaller step, not a different scan.
    await poke(poked, { ...slowTuning, scanLimits: { extractionsPerRun: 2 } });
    alarms = await driveUntilIdle();
  });

  it("chains one alarm after another until the pass is done", async () => {
    // Five fixtures, two a step: the scan records the three steps it took,
    // and the import had the alarm after them.
    expect((await completedPass()).counts.steps).toBe(3);
    expect(alarms).toBeGreaterThanOrEqual(3);
  });

  it("indexes the whole library across those steps", async () => {
    await expectWholeLibrary();
    expect((await completedPass()).counts.indexed).toBe(fixtures.tracks.length);
  });
});

/* ============================== a poke while a pass is in flight == */

describe("a second poke while a pass is in flight", () => {
  const poked = new Date(FIRST_POKE.getTime() + 3 * QUARTER_HOUR);
  const pokedAgain = new Date(poked.getTime() + QUARTER_HOUR);
  let betweenSteps = "";
  let duringAStep = "";
  let due: number | null = null;
  let dueAfterSecondPoke: number | null = null;

  beforeAll(async () => {
    await resetLibrary();
    await seedFixtureFiles();

    // One track a step, so the pass is still going after the first alarm.
    await poke(poked, { ...slowTuning, scanLimits: { extractionsPerRun: 1 } });
    await runNextAlarm();
    due = await nextAlarmAt();

    // Between two steps, where an alarm is scheduled and nothing is running.
    betweenSteps = await poke(pokedAgain);
    dueAfterSecondPoke = await nextAlarmAt();

    duringAStep = await pokeDuringAStep(pokedAgain);
  });

  it("starts nothing new between two steps", () => {
    expect(betweenSteps).toBe("running");
  });

  it("starts nothing new during a step either", () => {
    // The harder half of the same question. A step is not atomic — input
    // gates only cover storage operations, so a poke really can arrive while
    // `runScan` waits on R2 — and `getAlarm()` answers null while the
    // handler runs, so the driver has nothing to see but the instant its
    // state was armed at.
    expect(duringAStep).toBe("running");
  });

  it("leaves the alarm the pass had already scheduled", () => {
    expect(due).not.toBeNull();
    expect(dueAfterSecondPoke).toBe(due);
  });

  it("finishes the pass the first poke started, under its own stamp", async () => {
    await driveUntilIdle();

    // Had either poke been taken, the pass would carry the later stamp and
    // its steps would have started over.
    expect((await completedPass()).startedAt).toBe(poked.getTime());
    await expectWholeLibrary();
  });
});

/* ========================================== a step that throws == */

describe("a step that keeps throwing", () => {
  const poked = new Date(FIRST_POKE.getTime() + 5 * QUARTER_HOUR);

  /** How long the first retry waits; each one after it doubles. */
  const FIRST_RETRY = 600_000;

  /** The ceiling the doubling stops at, reached by the third retry. */
  const MAX_RETRY = 2_000_000;

  /** How many steps may fail in a row before the driver gives the pass up. */
  const MAX_FAILURES = 4;

  /** A scan cannot read its own state without this table, so it throws. */
  async function breakTheScan(): Promise<void> {
    await testEnv.DB.exec("ALTER TABLE property RENAME TO property_taken_away");
  }

  async function mendTheScan(): Promise<void> {
    await testEnv.DB.exec("ALTER TABLE property_taken_away RENAME TO property");
  }

  /**
   * Runs one alarm and asserts how long after it the next one is due. The
   * alarm is set a moment after the clock is read here, so the delay is
   * what was asked for plus however long the step took to fail.
   */
  async function expectNextAlarmIn(delayMs: number): Promise<void> {
    const before = Date.now();
    expect(await runNextAlarm()).toBe(true);

    const due = await nextAlarmAt();
    if (due === null) {
      throw new Error("the driver scheduled no further alarm");
    }

    expect(due - before).toBeGreaterThanOrEqual(delayMs);
    expect(due - before).toBeLessThan(delayMs + 30_000);
  }

  beforeAll(async () => {
    await resetLibrary();
    await seedFixtureFiles();

    await poke(poked, {
      ...slowTuning,
      firstRetryDelayMs: FIRST_RETRY,
      maxRetryDelayMs: MAX_RETRY,
      maxFailures: MAX_FAILURES,
    });
    await breakTheScan();
  });

  it("reschedules a failed step with a backoff that doubles and then caps", async () => {
    // The delay each failure asks for is how the count of consecutive
    // failures shows itself: doubling means it went up.
    await expectNextAlarmIn(FIRST_RETRY);
    await expectNextAlarmIn(2 * FIRST_RETRY);
    // The third failure asks for 2,400,000 ms; the cap is what it gets.
    await expectNextAlarmIn(MAX_RETRY);
  });

  it("gives the pass up after the bounded number of failures", async () => {
    expect(await runNextAlarm()).toBe(true);

    expect(await nextAlarmAt()).toBeNull();
    expect(await driverIsIdle()).toBe(true);
  });

  it("is restarted by the next cron poke, and finishes", async () => {
    await mendTheScan();

    const restarted = new Date(poked.getTime() + QUARTER_HOUR);
    expect(await poke(restarted)).toBe("started");
    await driveUntilIdle();

    await expectWholeLibrary();
  });
});

/* ================================ the delays production runs with == */

describe("the delays a pass runs with when nothing is injected", () => {
  const poked = new Date(FIRST_POKE.getTime() + 7 * QUARTER_HOUR);
  const pokedAgain = new Date(poked.getTime() + QUARTER_HOUR);

  /** How long after a step the next one is due, with no tuning at all. */
  const STEP_DELAY = 1_000;

  /** How long after the first failed step it is tried again. */
  const FIRST_RETRY = 2_000;

  beforeAll(async () => {
    await resetLibrary();
    await seedFixtureFiles();
  });

  it("puts the next step a second after the one before", async () => {
    const before = Date.now();
    expect(await poke(poked, {})).toBe("started");

    const due = await nextAlarmAt();
    expect(due).not.toBeNull();
    expect((due ?? 0) - before).toBeGreaterThanOrEqual(STEP_DELAY);
    expect((due ?? 0) - before).toBeLessThan(STEP_DELAY + 30_000);

    await driveUntilIdle();
  });

  it("waits two seconds before trying a failed step again", async () => {
    // Only the failure bound is injected, and only so that the driver stops
    // after the second failure instead of retrying for a minute; the delay
    // asserted here is the production one.
    expect(await poke(pokedAgain, { maxFailures: 2 })).toBe("started");
    await testEnv.DB.exec("ALTER TABLE property RENAME TO property_taken_away");

    const before = Date.now();
    expect(await runNextAlarm()).toBe(true);
    const due = await nextAlarmAt();
    expect(due).not.toBeNull();
    expect((due ?? 0) - before).toBeGreaterThanOrEqual(FIRST_RETRY);
    expect((due ?? 0) - before).toBeLessThan(FIRST_RETRY + 30_000);

    // The second failure is the bound, so the driver stops and leaves no
    // alarm behind for the rest of this file to trip over.
    expect(await runNextAlarm()).toBe(true);
    expect(await driverIsIdle()).toBe(true);
    await testEnv.DB.exec("ALTER TABLE property_taken_away RENAME TO property");
  });
});
