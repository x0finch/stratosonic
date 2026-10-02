import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { RESCAN_QUIET_MS } from "../src/scanner/driver";
import { readLastScanSummary, readScanProgress } from "../src/scanner/state";
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
import { resetLibrary, seedFixtureFiles } from "./scan-support";
import { testEnv } from "./support";

/**
 * The debounced rescan after a file change (#130, #83 "Rescan after a
 * change"): the console's uploads and deletes `touch` the scan driver, which
 * starts one pass once the library has been quiet for the window, keeps at
 * most one pass queued, and follows a running pass with exactly one more.
 * **Scan now** and the cron stay immediate.
 *
 * The driver is the real Durable Object, driven as test/scan-driver.test.ts
 * drives it. Every pass runs with `slowTuning`'s step delay, so no step runs
 * unless the test fires it and every pass that completes is seen
 * (`stepped`). The window is either long (`LONG`), so its alarm never fires
 * by itself, or short (`SHORT`) where a test needs the deadline to pass, in
 * which case it waits that long on the real clock: the debounce alarm decides
 * by the time it runs at, not by who fired it.
 */

/** A window no test outlives: only the test's own calls fire its alarm. */
const LONG = 600_000;

/** A window a test waits out on the real clock. */
const SHORT = 3_000;

/** The `startedAt` of every pass that completed, in order, as `stepped` saw them. */
let completed: number[] = [];

/** Fires the next alarm, and notes the pass whose scan phase it completed. */
async function stepped(): Promise<void> {
  await runNextAlarm();

  const summary = await readLastScanSummary(database(testEnv));
  if (summary !== null && completed.at(-1) !== summary.startedAt) {
    completed.push(summary.startedAt);
  }
}

/** Fires alarms until no pass is in flight (the driver's state is gone). */
async function finishThePass(limit = 30): Promise<void> {
  for (let alarms = 0; alarms <= limit; alarms++) {
    if (!(await storedKeys()).includes("driver")) {
      return;
    }
    await stepped();
  }

  throw new Error(`the pass was still running after ${limit} alarms`);
}

/** Fires alarms until the driver is idle: every pass done, nothing pending. */
async function settle(limit = 60): Promise<void> {
  for (let alarms = 0; alarms <= limit; alarms++) {
    if (await driverIsIdle()) {
      return;
    }
    await stepped();
  }

  throw new Error(`the driver was still busy after ${limit} alarms`);
}

/** Waits on the real clock until `instant` has passed. */
async function waitUntil(instant: number): Promise<void> {
  const wait = instant - Date.now() + 50;
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

function iso(instant: number): string {
  return new Date(instant).toISOString();
}

async function freshLibrary(): Promise<void> {
  await resetLibrary();
  await seedFixtureFiles();
  completed = [];
}

beforeAll(async () => {
  // The playlist import, the second half of every pass, needs its owner.
  await bootstrapAdmin();
});

afterAll(async () => {
  // Nothing in this file may leave a pass or a change behind.
  expect(await driverIsIdle()).toBe(true);
});

/* ======================================= changes with no pass == */

describe("changes while no pass is in flight", () => {
  // Both in the past, as changes a moment ago are: the window is still open.
  const first = Date.now() - 60_000;
  const second = first + 30_000;
  let firstSchedule: unknown;
  let firstAlarm: number | null = null;
  let firstKeys: string[] = [];
  let secondSchedule: unknown;
  let secondAlarm: number | null = null;

  beforeAll(async () => {
    await freshLibrary();

    firstSchedule = await touch(first, { quietMs: LONG });
    firstAlarm = await nextAlarmAt();
    firstKeys = await storedKeys();

    secondSchedule = await touch(second, { quietMs: LONG });
    secondAlarm = await nextAlarmAt();
  });

  it("sets the alarm at changedAt + quiet and starts no pass", async () => {
    expect(firstSchedule).toEqual({ scheduledAt: iso(first + LONG), afterCurrentPass: false });
    expect(firstAlarm).toBe(first + LONG);
    expect(firstKeys).toEqual(["pending"]);
    expect(await readScanProgress(database(testEnv))).toBeNull();
  });

  it("moves the alarm on a second change", () => {
    expect(secondSchedule).toEqual({ scheduledAt: iso(second + LONG), afterCurrentPass: false });
    expect(secondAlarm).toBe(second + LONG);
  });

  it("keeps the later change when an earlier one arrives after it", async () => {
    expect(await touch(first + 10_000, { quietMs: LONG })).toEqual(secondSchedule);
    expect(await nextAlarmAt()).toBe(second + LONG);
  });

  it("re-arms an alarm that fires before the moved deadline, and runs nothing", async () => {
    // The alarm the first change set would have fired at `first + LONG`, which
    // the second change moved: an alarm that fires early finds the library
    // not yet quiet.
    await stepped();

    expect(await nextAlarmAt()).toBe(second + LONG);
    expect(await storedKeys()).toEqual(["pending"]);
    expect(await readScanProgress(database(testEnv))).toBeNull();
    expect(completed).toEqual([]);
  });

  it("is absorbed by Scan now: one pass at once, and no follow-up", async () => {
    // Scan now pokes with the wall clock (`pokeScanDriver`), which is after
    // every change so far.
    const pressed = Date.now();
    expect(await driver().start(pressed, slowTuning)).toBe("started");
    expect(await storedKeys()).toEqual(["driver"]);

    await settle();

    expect(completed).toEqual([pressed]);
    expect(await nextAlarmAt()).toBeNull();
    expect(await driverIsIdle()).toBe(true);
  });
});

/* ============================================ the deadline == */

describe("a change whose quiet window has passed", () => {
  let changedAt = 0;

  beforeAll(async () => {
    await freshLibrary();

    changedAt = Date.now();
    await touch(changedAt, { quietMs: SHORT });
    await waitUntil(changedAt + SHORT);
  });

  it("starts a pass at the deadline, stamped then, and the change is no longer pending", async () => {
    // Whoever fires it - this call, or miniflare on its own once it is due -
    // the debounce alarm starts the pass, whose first step waits a slow step
    // delay for this test to fire it.
    await stepped();

    const keys = await storedKeys();
    expect(keys).not.toContain("pending");
    expect(keys).toEqual(["driver"]);

    await settle();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toBeGreaterThanOrEqual(changedAt + SHORT);
  });

  it("leaves the driver idle, its storage empty", async () => {
    expect(await nextAlarmAt()).toBeNull();
    expect(await driverIsIdle()).toBe(true);
  });
});

/* =================================== changes during a pass == */

describe("changes while a pass is in flight", () => {
  /** A pass a cron poke started a minute ago. */
  const poked = Date.now() - 60_000;
  const touches: unknown[] = [];
  let lastChange = 0;
  let alarmDuringPass: number | null = null;
  let alarmBeforeTouches: number | null = null;

  beforeAll(async () => {
    await freshLibrary();

    // One track a step, so the pass has several steps to land changes in.
    await poke(new Date(poked), { ...slowTuning, scanLimits: { extractionsPerRun: 1 } });
    await stepped();
    alarmBeforeTouches = await nextAlarmAt();

    // Five changes: four between steps, one in the middle of a step.
    for (let change = 0; change < 4; change++) {
      lastChange = Date.now();
      touches.push(await touch(lastChange, { quietMs: SHORT }));
    }
    alarmDuringPass = await nextAlarmAt();
    lastChange = Date.now();
    touches.push(await touchDuringAStep(lastChange, { quietMs: SHORT }));

    await finishThePass();
  });

  it("leaves the pass alone, and says one more follows it", () => {
    expect(touches).toEqual(
      Array.from({ length: 5 }, () => ({ scheduledAt: null, afterCurrentPass: true })),
    );
    expect(alarmDuringPass).toBe(alarmBeforeTouches);
  });

  it("finishes the pass under its own stamp, with one follow-up queued", async () => {
    expect(completed).toEqual([poked]);
    expect(await storedKeys()).toEqual(["pending"]);
  });

  it("debounces the follow-up from the last change", async () => {
    // Fired at once, the queued alarm finds the window since the last
    // change still open, and waits for the rest of it. (A slow machine may
    // have let the window close already, and then the follow-up starts.)
    const firedAt = Date.now();
    await stepped();
    if (firedAt + 100 < lastChange + SHORT) {
      const keys = await storedKeys();
      if (!keys.includes("driver")) {
        expect(keys).toEqual(["pending"]);
        expect(await nextAlarmAt()).toBe(lastChange + SHORT);
      }
    }

    await waitUntil(lastChange + SHORT);
    await settle();

    expect(completed).toHaveLength(2);
    expect(completed[1]).toBeGreaterThanOrEqual(lastChange + SHORT);
  });

  it("runs exactly one follow-up for the five changes, then stops", async () => {
    expect(completed).toHaveLength(2);
    expect(await nextAlarmAt()).toBeNull();
    expect(await driverIsIdle()).toBe(true);
  });
});

/* =========================================== the cron poke == */

describe("a cron poke while a change is pending", () => {
  it("stamped before the change, runs a pass and then a follow-up", async () => {
    await freshLibrary();

    const changedAt = Date.now();
    await touch(changedAt, { quietMs: SHORT });
    // The cron's scheduled time precedes the change: its pass may have listed
    // the bucket before the change landed.
    const scheduled = changedAt - 1_000;
    expect(await poke(new Date(scheduled))).toBe("started");
    expect(await storedKeys()).toEqual(["driver", "pending"]);

    await finishThePass();
    expect(completed).toEqual([scheduled]);
    expect(await storedKeys()).toEqual(["pending"]);

    await waitUntil(changedAt + SHORT);
    await settle();

    expect(completed).toHaveLength(2);
    expect(completed[1]).toBeGreaterThanOrEqual(changedAt + SHORT);
    expect(await driverIsIdle()).toBe(true);
  });

  it("stamped after the change, runs a pass and no follow-up", async () => {
    await freshLibrary();

    const changedAt = Date.now();
    await touch(changedAt, { quietMs: LONG });
    const scheduled = changedAt + 1;
    expect(await poke(new Date(scheduled))).toBe("started");
    expect(await storedKeys()).toEqual(["driver"]);

    await settle();

    expect(completed).toEqual([scheduled]);
    expect(await nextAlarmAt()).toBeNull();
    expect(await driverIsIdle()).toBe(true);
  });
});

/* =========================================== giving up == */

describe("a pass given up with a change pending", () => {
  it("clears the change too, leaving the storage empty", async () => {
    await freshLibrary();

    await poke(new Date(Date.now() - 60_000), { ...slowTuning, maxFailures: 2 });
    expect(await touch(Date.now(), { quietMs: SHORT })).toEqual({
      scheduledAt: null,
      afterCurrentPass: true,
    });

    await testEnv.DB.exec("ALTER TABLE property RENAME TO property_taken_away");
    try {
      await runNextAlarm();
      await runNextAlarm();
    } finally {
      await testEnv.DB.exec("ALTER TABLE property_taken_away RENAME TO property");
    }

    expect(await nextAlarmAt()).toBeNull();
    expect(await driverIsIdle()).toBe(true);
  });
});

/* ======================================= production's window == */

describe("the window a change waits with when nothing is injected", () => {
  it("is two minutes", async () => {
    expect(RESCAN_QUIET_MS).toBe(120_000);

    const changedAt = Date.now();
    expect(await driver().touch(changedAt)).toEqual({
      scheduledAt: iso(changedAt + 120_000),
      afterCurrentPass: false,
    });
    expect(await nextAlarmAt()).toBe(changedAt + 120_000);

    // Scan now takes it, so nothing is left for the next file.
    await driver().start(Date.now(), slowTuning);
    await settle();
  });
});
