import { runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { RESCAN_QUIET_MS, type ScanDriver } from "../src/scanner/driver";
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
 * drives it. Every pass runs with `slowTuning`'s step delay and every change
 * with a window (`QUIET`) no test outlives, so no alarm fires unless the test
 * fires it, and every pass that completes is seen (`stepped`). Where a test
 * needs the window to have passed, it moves the pending change back by the
 * window (`elapse`), which is what the debounce alarm sees when that much
 * time has gone by.
 */

/** The window every change in this file waits with. */
const QUIET = 600_000;

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

/**
 * Lets `ms` go by for the pending change: it is moved back by that much, as
 * the debounce alarm would find it had the time passed.
 */
async function elapse(ms: number): Promise<void> {
  await runInDurableObject(driver(), async (_instance: ScanDriver, state) => {
    const pending = await state.storage.get<{ changedAt: number }>("pending");
    if (pending === undefined) {
      throw new Error("no change is pending");
    }
    await state.storage.put("pending", { ...pending, changedAt: pending.changedAt - ms });
  });
}

/** When the pending change was made, as the driver keeps it. */
function pendingChangedAt(): Promise<number | undefined> {
  return runInDurableObject(
    driver(),
    async (_instance: ScanDriver, state) =>
      (await state.storage.get<{ changedAt: number }>("pending"))?.changedAt,
  );
}

function iso(instant: number): string {
  return new Date(instant).toISOString();
}

async function freshLibrary(): Promise<void> {
  await resetLibrary();
  await seedFixtureFiles();
  completed = [];
}

const afterCurrentPass = { scheduledAt: null, afterCurrentPass: true };

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

    firstSchedule = await touch(first, { quietMs: QUIET });
    firstAlarm = await nextAlarmAt();
    firstKeys = await storedKeys();

    secondSchedule = await touch(second, { quietMs: QUIET });
    secondAlarm = await nextAlarmAt();
  });

  it("sets the alarm at changedAt + quiet and starts no pass", async () => {
    expect(firstSchedule).toEqual({ scheduledAt: iso(first + QUIET), afterCurrentPass: false });
    expect(firstAlarm).toBe(first + QUIET);
    expect(firstKeys).toEqual(["pending"]);
    expect(await readScanProgress(database(testEnv))).toBeNull();
  });

  it("moves the alarm on a second change", () => {
    expect(secondSchedule).toEqual({ scheduledAt: iso(second + QUIET), afterCurrentPass: false });
    expect(secondAlarm).toBe(second + QUIET);
  });

  it("keeps the later change when an earlier one arrives after it", async () => {
    expect(await touch(first + 10_000, { quietMs: QUIET })).toEqual(secondSchedule);
    expect(await nextAlarmAt()).toBe(second + QUIET);
  });

  it("takes a change stamped in the future as made now", async () => {
    const before = Date.now();
    const schedule = await touch(before + 3_600_000, { quietMs: QUIET });
    const after = Date.now();

    const changedAt = (await pendingChangedAt()) ?? 0;
    expect(changedAt).toBeGreaterThanOrEqual(before);
    expect(changedAt).toBeLessThanOrEqual(after);
    expect(schedule).toEqual({ scheduledAt: iso(changedAt + QUIET), afterCurrentPass: false });
    expect(await nextAlarmAt()).toBe(changedAt + QUIET);
  });

  it("re-arms an alarm that fires before the moved deadline, and runs nothing", async () => {
    const changedAt = (await pendingChangedAt()) ?? 0;

    // An alarm that fires early finds the library not yet quiet.
    await stepped();

    expect(await nextAlarmAt()).toBe(changedAt + QUIET);
    expect(await storedKeys()).toEqual(["pending"]);
    expect(await readScanProgress(database(testEnv))).toBeNull();
    expect(completed).toEqual([]);
  });

  it("is absorbed by Scan now: one pass at once, and no follow-up", async () => {
    // Scan now pokes with the wall clock (`pokeScanDriver`), which is after
    // every change so far. The change stays until the pass's end, which
    // finds it covered.
    const pressed = Date.now();
    expect(await driver().start(pressed, slowTuning)).toBe("started");
    expect(await storedKeys()).toEqual(["driver", "pending"]);

    await settle();

    expect(completed).toEqual([pressed]);
    expect(await nextAlarmAt()).toBeNull();
    expect(await driverIsIdle()).toBe(true);
  });
});

/* ============================================ the deadline == */

describe("a change whose quiet window has passed", () => {
  it("starts one pass at the deadline, stamped then, and no follow-up", async () => {
    await freshLibrary();

    const changedAt = Date.now();
    await touch(changedAt, { quietMs: QUIET });
    await elapse(QUIET);

    const firedAt = Date.now();
    await stepped();

    // The pass is armed; the change waits for its end to be found covered.
    expect(await storedKeys()).toEqual(["driver", "pending"]);
    expect(await readScanProgress(database(testEnv))).toBeNull();

    await settle();
    expect(completed).toHaveLength(1);
    expect(completed[0]).toBeGreaterThanOrEqual(firedAt);
    expect(await nextAlarmAt()).toBeNull();
    expect(await driverIsIdle()).toBe(true);
  });

  it("starts the pass for an alarm a moment early, rather than re-arming", async () => {
    await freshLibrary();

    await touch(Date.now(), { quietMs: QUIET });
    // Half a second before the deadline: within the tolerance.
    await elapse(QUIET - 500);
    await stepped();

    expect(await storedKeys()).toEqual(["driver", "pending"]);

    await settle();
    expect(completed).toHaveLength(1);
  });
});

/* =================================== changes during a pass == */

describe("five changes while a pass is in flight", () => {
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
      touches.push(await touch(Date.now(), { quietMs: QUIET }));
    }
    alarmDuringPass = await nextAlarmAt();
    touches.push(await touchDuringAStep(Date.now(), { quietMs: QUIET }));
    lastChange = (await pendingChangedAt()) ?? 0;

    await finishThePass();
  });

  it("leaves the pass alone, and says one more follows it", () => {
    expect(touches).toEqual(Array.from({ length: 5 }, () => afterCurrentPass));
    expect(alarmDuringPass).toBe(alarmBeforeTouches);
  });

  it("finishes the pass under its own stamp, with one follow-up queued", async () => {
    expect(completed).toEqual([poked]);
    expect(await storedKeys()).toEqual(["pending"]);
    expect(await nextAlarmAt()).toBeGreaterThanOrEqual(lastChange + QUIET);
  });

  it("debounces the follow-up from the last change", async () => {
    // Fired at once, the queued alarm finds the window since the last
    // change still open, and waits for the rest of it.
    await stepped();

    expect(await storedKeys()).toEqual(["pending"]);
    expect(await nextAlarmAt()).toBe(lastChange + QUIET);
    expect(completed).toEqual([poked]);
  });

  it("runs exactly one follow-up for the five changes once the window passes, then stops", async () => {
    await elapse(QUIET);
    await settle();

    expect(completed).toHaveLength(2);
    expect(completed[1]).toBeGreaterThan(lastChange);
    expect(await nextAlarmAt()).toBeNull();
    expect(await driverIsIdle()).toBe(true);
  });
});

describe("a change during the final step only", () => {
  it("is seen at the pass's end, which queues the follow-up", async () => {
    await freshLibrary();

    const poked = Date.now() - 60_000;
    await poke(new Date(poked));
    // The fixtures fit one scan step; the import's is the pass's last.
    await stepped();
    expect(await storedKeys()).toEqual(["driver"]);

    // The touch lands while the last step waits on R2 and D1, after the
    // alarm read its state: only a read of `pending` after the step sees it.
    expect(await touchDuringAStep(Date.now(), { quietMs: QUIET })).toEqual(afterCurrentPass);

    expect(completed).toEqual([poked]);
    expect(await storedKeys()).toEqual(["pending"]);

    await elapse(QUIET);
    await settle();
    expect(completed).toHaveLength(2);
    expect(await driverIsIdle()).toBe(true);
  });
});

describe("the boundary of the rule: a change at the pass's own stamp", () => {
  it("is not covered by a pass a touch finds in flight with that stamp", async () => {
    await freshLibrary();

    const poked = Date.now() - 60_000;
    await poke(new Date(poked));
    expect(await touch(poked, { quietMs: QUIET })).toEqual(afterCurrentPass);

    await finishThePass();
    expect(completed).toEqual([poked]);
    expect(await storedKeys()).toEqual(["pending"]);

    await elapse(QUIET);
    await settle();
    expect(completed).toHaveLength(2);
  });

  it("is not covered by a pass a cron poke stamped with it starts", async () => {
    await freshLibrary();

    const changedAt = Date.now() - 60_000;
    await touch(changedAt, { quietMs: QUIET });
    expect(await poke(new Date(changedAt))).toBe("started");

    await finishThePass();
    expect(completed).toEqual([changedAt]);
    expect(await storedKeys()).toEqual(["pending"]);

    await elapse(QUIET);
    await settle();
    expect(completed).toHaveLength(2);
  });

  it("one millisecond earlier, is covered: the touch says so, and no follow-up runs", async () => {
    await freshLibrary();

    const poked = Date.now() - 60_000;
    await poke(new Date(poked));
    expect(await touch(poked - 1, { quietMs: QUIET })).toEqual({
      scheduledAt: null,
      afterCurrentPass: false,
    });

    await settle();
    expect(completed).toEqual([poked]);
    expect(await nextAlarmAt()).toBeNull();
  });
});

/* =========================================== the cron poke == */

describe("a cron poke while a change is pending", () => {
  it("stamped before the change, runs a pass and then a follow-up", async () => {
    await freshLibrary();

    const changedAt = Date.now();
    await touch(changedAt, { quietMs: QUIET });
    // The cron's scheduled time precedes the change: its pass may have listed
    // the bucket before the change landed.
    const scheduled = changedAt - 1_000;
    expect(await poke(new Date(scheduled))).toBe("started");
    expect(await storedKeys()).toEqual(["driver", "pending"]);

    await finishThePass();
    expect(completed).toEqual([scheduled]);
    expect(await storedKeys()).toEqual(["pending"]);

    await elapse(QUIET);
    await settle();

    expect(completed).toHaveLength(2);
    expect(completed[1]).toBeGreaterThan(changedAt);
    expect(await driverIsIdle()).toBe(true);
  });

  it("stamped after the change, runs a pass and no follow-up", async () => {
    await freshLibrary();

    const changedAt = Date.now();
    await touch(changedAt, { quietMs: QUIET });
    const scheduled = changedAt + 1;
    expect(await poke(new Date(scheduled))).toBe("started");

    await settle();

    expect(completed).toEqual([scheduled]);
    expect(await nextAlarmAt()).toBeNull();
    expect(await driverIsIdle()).toBe(true);
  });
});

/* =========================================== giving up == */

describe("a pass given up with a change pending", () => {
  const poked = Date.now() - 60_000;
  let changedAt = 0;

  beforeAll(async () => {
    await freshLibrary();

    // One track a step, so the pass leaves a resumable cursor in D1.
    await poke(new Date(poked), {
      ...slowTuning,
      maxFailures: 2,
      scanLimits: { extractionsPerRun: 1 },
    });
    await stepped();
    expect((await readScanProgress(database(testEnv)))?.startedAt).toBe(poked);

    changedAt = Date.now();
    expect(await touch(changedAt, { quietMs: QUIET })).toEqual(afterCurrentPass);

    await testEnv.DB.exec("ALTER TABLE property RENAME TO property_taken_away");
    try {
      await runNextAlarm();
      await runNextAlarm();
    } finally {
      await testEnv.DB.exec("ALTER TABLE property_taken_away RENAME TO property");
    }
  });

  it("stops the pass and keeps the change", async () => {
    expect(await nextAlarmAt()).toBeNull();
    expect(await storedKeys()).toEqual(["pending"]);
  });

  it("follows the pass the next cron poke resumes with one more", async () => {
    // The poke's pass resumes the cursor, and with it the old stamp, so it
    // may not list the changed key: its end queues the follow-up.
    expect(await poke(new Date())).toBe("started");
    await finishThePass();
    expect(completed).toEqual([poked]);
    expect(await storedKeys()).toEqual(["pending"]);

    await elapse(QUIET);
    await settle();
    expect(completed).toHaveLength(2);
    expect(completed[1]).toBeGreaterThan(changedAt);
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
