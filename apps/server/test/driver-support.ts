import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { PokeOutcome, ScanDriver, ScanDriverTuning } from "../src/scanner/driver";
import { SCAN_DRIVER_INSTANCE } from "../src/scanner/driver";
import { testEnv } from "./support";

/**
 * Driving the scan driver from a test.
 *
 * The Durable Object is the real one, defined in the Worker under test and
 * created by the binding in wrangler.jsonc, so a test pokes it exactly as the
 * cron entry does and then runs its alarms with the harness's
 * `runDurableObjectAlarm`, which fires the scheduled alarm at once instead of
 * waiting for its delay (workers/testing/vitest-integration/test-apis).
 *
 * Miniflare also runs alarms of its own accord when their time arrives, so a
 * test that needs to count steps sets the delays far enough out
 * (`slowTuning`) that only its own calls can fire one. Nothing is lost when
 * one does fire by itself - a step is a step - so the helpers below are
 * written to be correct either way: they ask whether the driver has finished,
 * not who ran the last step.
 */

/** The one well-known instance the cron pokes. */
export function driver() {
  return testEnv.SCAN_DRIVER.get(testEnv.SCAN_DRIVER.idFromName(SCAN_DRIVER_INSTANCE));
}

/**
 * Delays long enough that no alarm fires unless the test fires it. The steps
 * themselves are unchanged: this moves the clock, not the work.
 */
export const slowTuning: ScanDriverTuning = {
  stepDelayMs: 600_000,
  firstRetryDelayMs: 600_000,
  maxRetryDelayMs: 4_800_000,
};

/** Pokes the driver the way `scheduled` does, with the tuning a test needs. */
export function poke(now: Date, tuning: ScanDriverTuning = slowTuning): Promise<PokeOutcome> {
  return driver().start(now.getTime(), tuning);
}

/** Runs the scheduled alarm at once; false when there was none to run. */
export function runNextAlarm(): Promise<boolean> {
  return runDurableObjectAlarm(driver());
}

/**
 * Pokes the driver in the middle of a step, and says what the poke answered.
 *
 * This is the race a quiescent poke cannot reach. The step is started but
 * not awaited, so the poke is delivered while it is waiting on R2 and D1 —
 * which the runtime allows, because input gates only cover storage
 * operations — and the alarm is deleted first, as the platform deletes it
 * before invoking the handler, so `getAlarm()` answers null throughout, just
 * as it does during a real alarm.
 */
export function pokeDuringAStep(
  now: Date,
  tuning: ScanDriverTuning = slowTuning,
): Promise<PokeOutcome> {
  return runInDurableObject(driver(), async (instance: ScanDriver, state) => {
    await state.storage.deleteAlarm();

    const step = instance.alarm();
    const outcome = await instance.start(now.getTime(), tuning);
    await step;

    return outcome;
  });
}

/** When the next alarm is due, or null when the driver has scheduled none. */
export function nextAlarmAt(): Promise<number | null> {
  return runInDurableObject(driver(), (_instance: ScanDriver, state) => state.storage.getAlarm());
}

/**
 * Whether the driver has stopped: a pass that ends empties its storage, which
 * is what lets the object cease to exist between passes.
 */
export async function driverIsIdle(): Promise<boolean> {
  const stored = await runInDurableObject(driver(), (_instance: ScanDriver, state) =>
    state.storage.list(),
  );

  return stored.size === 0;
}

/**
 * Runs alarm after alarm until the driver stops, and says how many alarms
 * this call ran. A pass that has not ended after `limit` of them is a loop.
 */
export async function driveUntilIdle(limit = 60): Promise<number> {
  for (let steps = 0; steps <= limit; steps++) {
    if (await driverIsIdle()) {
      return steps;
    }

    await runNextAlarm();
  }

  throw new Error(`the scan driver was still running after ${limit} alarms`);
}
