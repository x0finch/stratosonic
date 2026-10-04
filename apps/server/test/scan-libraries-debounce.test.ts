import { runInDurableObject } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import type { ScanDriver } from "../src/scanner/driver";
import { readLastScanSummary, type ScanSummary } from "../src/scanner/state";
import { bootstrapAdmin } from "./browsing-support";
import {
  driver,
  driverIsIdle,
  nextAlarmAt,
  poke,
  runNextAlarm,
  slowTuning,
  storedKeys,
  touch,
  touchDuringAStep,
} from "./driver-support";
import {
  ARCHIVE,
  connectLibrary,
  type FakeLibrary,
  installFakeLibrary,
  progressNow,
  putFixtureInArchive,
  putFixtureInBound,
  resetLibraries,
} from "./scan-libraries-support";
import { testEnv } from "./support";

/**
 * ADR-0008 with two libraries (#84, "ADR-0008: no change to the rule"): a
 * change is pending if and only if it was made at or after the start of the
 * latest pass, every library's progress carries the pass's one stamp, and
 * the debounced pass walks every library. So a change made while the pass
 * is in library 2 gives exactly one follow-up pass, Scan now absorbs that
 * follow-up, and the driver's storage is empty after.
 */

const QUIET = 600_000;
const afterCurrentPass = { scheduledAt: null, afterCurrentPass: true };

/** Every pass that completed, as its summary says, in order. */
let completed: ScanSummary[] = [];
let installed: FakeLibrary;

async function stepped(): Promise<void> {
  await runNextAlarm();
  const summary = await readLastScanSummary(database(testEnv));
  if (summary !== null && completed.at(-1)?.startedAt !== summary.startedAt) {
    completed.push(summary);
  }
}

async function finishThePass(limit = 40): Promise<void> {
  for (let alarm = 0; alarm <= limit; alarm++) {
    if (!(await storedKeys()).includes("driver")) {
      return;
    }
    await stepped();
  }
  throw new Error(`the pass was still running after ${limit} alarms`);
}

async function settle(limit = 80): Promise<void> {
  for (let alarm = 0; alarm <= limit; alarm++) {
    if (await driverIsIdle()) {
      return;
    }
    await stepped();
  }
  throw new Error(`the driver was still busy after ${limit} alarms`);
}

/** Lets the window go by for the pending change, as `scan-debounce.test.ts` does. */
async function elapse(ms: number): Promise<void> {
  await runInDurableObject(driver(), async (_instance: ScanDriver, state) => {
    const pending = await state.storage.get<{ changedAt: number }>("pending");
    if (pending === undefined) {
      throw new Error("no change is pending");
    }
    await state.storage.put("pending", { ...pending, changedAt: pending.changedAt - ms });
  });
}

/** Runs the pass a minute-old cron poke started until it is in library 2. */
async function passInLibrary2(): Promise<number> {
  const poked = Date.now() - 60_000;
  await poke(new Date(poked), { ...slowTuning, scanLimits: { pageSize: 1, pagesPerRun: 1 } });
  for (let step = 0; step < 10; step++) {
    if ((await progressNow())?.libraryId === ARCHIVE.id) {
      return poked;
    }
    await stepped();
  }
  throw new Error("the pass never reached library 2");
}

beforeAll(async () => {
  await bootstrapAdmin();
});

beforeEach(async () => {
  await resetLibraries();
  installed = installFakeLibrary();
  await connectLibrary(installed.fake);
  completed = [];
  await putFixtureInBound("Fallback Artist/Fallback Album/01 Untagged.mp3", "untagged.mp3");
  await putFixtureInArchive("Silent Artist/Quiet Album/01 Silent Track.mp3", "silent-track.mp3");
  await putFixtureInArchive(
    "Mute Ensemble/Faststart Sessions/01 Front Loaded.m4a",
    "front-loaded.m4a",
  );
  await putFixtureInArchive(
    "Mute Ensemble/Trailing Sessions/01 Tail Loaded.m4a",
    "tail-loaded.m4a",
  );
});

afterEach(() => {
  installed.spy.mockRestore();
});

afterAll(async () => {
  expect(await driverIsIdle()).toBe(true);
});

describe("a change while the pass is in library 2", () => {
  it("leaves the pass alone, and gives exactly one follow-up pass over every library", async () => {
    const poked = await passInLibrary2();

    expect(await touch(Date.now(), { quietMs: QUIET })).toEqual(afterCurrentPass);
    expect(await touchDuringAStep(Date.now(), { quietMs: QUIET })).toEqual(afterCurrentPass);
    expect((await progressNow())?.startedAt).toBe(poked);

    await finishThePass();
    expect(completed.map((summary) => summary.startedAt)).toEqual([poked]);
    expect(await storedKeys()).toEqual(["pending"]);
    expect(await nextAlarmAt()).not.toBeNull();

    await elapse(QUIET);
    await settle();

    expect(completed).toHaveLength(2);
    const followUp = completed[1];
    expect(followUp?.startedAt).toBeGreaterThan(poked);
    expect(Object.keys(followUp?.libraries ?? {}).sort()).toEqual(["1", "2"]);
    expect(await nextAlarmAt()).toBeNull();
    expect(await driverIsIdle()).toBe(true);
  });

  it("has its follow-up absorbed by Scan now, after which the storage is empty", async () => {
    const poked = await passInLibrary2();
    expect(await touch(Date.now(), { quietMs: QUIET })).toEqual(afterCurrentPass);
    await finishThePass();
    expect(await storedKeys()).toEqual(["pending"]);

    // Scan now, stamped with the wall clock after the change: one pass at
    // once, which covers it, and no other.
    const pressed = Date.now();
    expect(await driver().start(pressed, slowTuning)).toBe("started");
    await settle();

    expect(completed.map((summary) => summary.startedAt)).toEqual([poked, pressed]);
    expect(await nextAlarmAt()).toBeNull();
    expect(await driverIsIdle()).toBe(true);
  });
});

describe("a change before the pass that reaches library 2", () => {
  it("is covered by that pass: no follow-up", async () => {
    await touch(Date.now() - 1_000, { quietMs: QUIET });
    const pressed = Date.now();
    expect(await driver().start(pressed, slowTuning)).toBe("started");
    await settle();

    expect(completed.map((summary) => summary.startedAt)).toEqual([pressed]);
    expect(Object.keys(completed[0]?.libraries ?? {}).sort()).toEqual(["1", "2"]);
    expect(await driverIsIdle()).toBe(true);
  });
});
