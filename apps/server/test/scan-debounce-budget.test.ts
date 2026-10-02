import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import type { ScanDriver } from "../src/scanner/driver";
import { bootstrapAdmin } from "./browsing-support";
import { cost, countingD1, type RecordedStatement, shape } from "./console-auth-support";
import { driver, driverIsIdle, poke, slowTuning } from "./driver-support";
import { seedFixtureFiles } from "./scan-support";
import { testEnv } from "./support";

/**
 * What the debounced rescan costs (#83, "Free-tier budget"): the rows "the
 * debounce alarm" and "the pass it starts". Each alarm is run as the
 * platform runs it, one Durable Object request, with its storage, D1 and R2
 * counted: Durable Object storage by rows read and written (`setAlarm` is
 * billed as a row written, developers.cloudflare.com/durable-objects/platform/pricing),
 * D1 with `countingD1`, R2 by operation.
 */

/** What one alarm did, as the budget table counts it. */
interface AlarmCost {
  readonly storageRowsRead: number;
  readonly storageRowsWritten: number;
  readonly d1: RecordedStatement[];
  /** R2 operations by method: `list` is Class A, `get` and `head` Class B. */
  readonly r2: string[];
}

function keysIn(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }
  return typeof value === "string" ? 1 : Object.keys(value ?? {}).length;
}

/** An R2 binding that notes each operation's method. */
function countingR2(inner: R2Bucket, r2: string[]): R2Bucket {
  return new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        r2.push(String(prop));
        return value.apply(target, args);
      };
    },
  });
}

/**
 * Runs the driver's next alarm as the platform does (the alarm is deleted,
 * then the handler runs) with its storage, D1 and R2 counted.
 */
function countedAlarm(): Promise<AlarmCost> {
  return counted(async (instance, state) => {
    await state.storage.deleteAlarm();
    await instance.alarm();
  });
}

/** One request of the driver, with its storage, D1 and R2 counted. */
function counted(
  request: (instance: ScanDriver, state: DurableObjectState) => Promise<unknown>,
): Promise<AlarmCost> {
  return runInDurableObject(driver(), async (instance: ScanDriver, state) => {
    let storageRowsRead = 0;
    let storageRowsWritten = 0;
    const r2: string[] = [];
    const d1 = countingD1(testEnv.DB);

    const storage = new Proxy(state.storage, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) => {
          if (prop === "get") {
            storageRowsRead += keysIn(args[0]);
          } else if (prop === "put") {
            storageRowsWritten += typeof args[0] === "string" ? 1 : keysIn(args[0]);
          } else if (prop === "delete") {
            storageRowsWritten += keysIn(args[0]);
          } else if (prop === "setAlarm") {
            storageRowsWritten += 1;
          }
          return value.apply(target, args);
        };
      },
    });
    const ctx = new Proxy(state, {
      get(target, prop) {
        if (prop === "storage") {
          return storage;
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const self = instance as unknown as { ctx: DurableObjectState; env: Env };
    const original = { ctx: self.ctx, env: self.env };
    self.ctx = ctx;
    self.env = { ...original.env, DB: d1.binding, MUSIC: countingR2(original.env.MUSIC, r2) };
    try {
      await request(instance, state);
    } finally {
      self.ctx = original.ctx;
      self.env = original.env;
    }

    return { storageRowsRead, storageRowsWritten, d1: [...d1.statements], r2 };
  });
}

/** Every alarm of the pass in flight, counted, until the driver is idle. */
async function countedPass(limit = 30): Promise<AlarmCost[]> {
  const alarms: AlarmCost[] = [];
  for (let count = 0; count <= limit; count++) {
    if (await driverIsIdle()) {
      return alarms;
    }
    alarms.push(await countedAlarm());
  }
  throw new Error(`the pass was still running after ${limit} alarms`);
}

/**
 * A change whose window has already closed, with no alarm left for miniflare
 * to fire by itself: the debounce alarm is then this test's to run.
 */
function quietChange(changedAt: number, quietMs: number): Promise<unknown> {
  return runInDurableObject(driver(), async (instance: ScanDriver, state) => {
    const schedule = await instance.touch(changedAt, { ...slowTuning, quietMs });
    await state.storage.deleteAlarm();
    return schedule;
  });
}

/** The pass's alarms summed, as the budget's columns. */
function summed(alarms: readonly AlarmCost[]) {
  const d1 = alarms.flatMap((alarm) => alarm.d1);
  const r2 = alarms.flatMap((alarm) => alarm.r2);
  return {
    alarms: alarms.length,
    d1: cost(d1),
    d1Shapes: d1.map(shape),
    r2List: r2.filter((method) => method === "list").length,
    r2Read: r2.filter((method) => method === "get" || method === "head").length,
  };
}

beforeAll(async () => {
  await bootstrapAdmin();
  await seedFixtureFiles();

  // A first pass indexes the fixtures, so the passes below meet the
  // unchanged library the budget table's row is written for.
  await poke(new Date());
  await countedPass();
});

describe("a change", () => {
  it("touches the driver with no pass in flight: two rows read, two written", async () => {
    const touched = await counted((instance) => instance.touch(Date.now(), slowTuning));

    // `pending` and `driver` read; `pending` put and the alarm set.
    expect(touched).toEqual({ storageRowsRead: 2, storageRowsWritten: 2, d1: [], r2: [] });
  });

  it("touches the driver during a pass: two rows read, one written", async () => {
    await poke(new Date());
    const touched = await counted((instance) => instance.touch(Date.now(), slowTuning));

    // The step chain keeps its alarm.
    expect(touched).toEqual({ storageRowsRead: 2, storageRowsWritten: 1, d1: [], r2: [] });

    await runInDurableObject(driver(), async (_instance: ScanDriver, state) => {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
    });
  });
});

describe("the debounce alarm", () => {
  it("re-arms before the deadline: one request, two rows read, one written, nothing else", async () => {
    await quietChange(Date.now(), 600_000);

    const alarm = await countedAlarm();

    expect(alarm).toEqual({ storageRowsRead: 2, storageRowsWritten: 1, d1: [], r2: [] });

    // Forget the change, which no pass is wanted for.
    await runInDurableObject(driver(), async (_instance: ScanDriver, state) => {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
    });
  });

  it("starts the pass at the deadline: two rows read, three written, no D1 or R2", async () => {
    await quietChange(Date.now() - 1_000, 500);

    const alarm = await countedAlarm();

    // `driver` and `pending` read; `pending` deleted, the pass's state put
    // and its first step's alarm set.
    expect(alarm).toEqual({ storageRowsRead: 2, storageRowsWritten: 3, d1: [], r2: [] });
  });
});

describe("the pass it starts", () => {
  it("costs what a cron pass costs over the same library", async () => {
    // The pass the alarm above started.
    const debounced = summed(await countedPass());

    await poke(new Date());
    const cron = summed(await countedPass());

    expect(debounced).toEqual(cron);
    // The fixtures fit one scan step and one import step.
    expect(debounced.alarms).toBe(2);
    // One listing for the scan and one for the import (Class A); the only
    // read is the import's of the one `.m3u`, since an unchanged library
    // reads no audio bytes (Class B).
    expect(debounced.r2List).toBe(2);
    expect(debounced.r2Read).toBe(1);
    // D1 as a cron pass, in the same statements.
    expect(debounced.d1).toEqual({ statements: 15, roundTrips: 7, rowsRead: 50, rowsWritten: 4 });
  });
});
