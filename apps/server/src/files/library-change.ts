import { property } from "@stratosonic/db";
import { sql } from "drizzle-orm";
import type { Database } from "../db";
import type { Env } from "../env";
import { pokeScanDriver } from "../scanner/status";

/**
 * Telling the library that the Files page changed the bucket (#83, "Rescan
 * after a change" and "The console's view is mirrored in D1"): the one place
 * a file route does it, so that the scan picks the change up without a
 * **Scan now**.
 *
 * A route that changed the bucket calls `recordLibraryChange` once, after
 * the change. It:
 *
 * 1. upserts the `LibraryChangedAt` property, keeping the larger instant, so
 *    the console's live view can show the pending pass without asking the
 *    driver. A failed write throws, and the route answers 500: the files are
 *    changed, the console reports the error, and the cron catches up;
 * 2. marks the library changed in the scan driver, which debounces the pass.
 *    A failure there is logged and answered as `scan: null`, never as an
 *    error, since the files did change.
 *
 * ---------------------------------------------------------------------------
 * STUB: replace with #130's exports at merge.
 *
 * Ticket A (#130) builds the debounce and owns three things this module
 * stands in for until it merges: `markLibraryChanged` and `ScanSchedule`
 * (`scanner/status.ts` / `scanner/driver.ts`), `RESCAN_QUIET_MS`
 * (`scanner/driver.ts`), and the `LibraryChangedAt` upsert (`scanner/state.ts`).
 * At the merge, delete the three stand-ins below and import #130's instead;
 * `recordLibraryChange` and every route stay as they are.
 *
 * Until then, `markLibraryChanged` pokes the driver as **Scan now** does, so
 * a change starts a pass at once rather than after the quiet window, and a
 * change during a pass queues no follow-up (the next cron pass covers it).
 * ---------------------------------------------------------------------------
 */

/** STUB (#130, `scanner/driver.ts`): the quiet window before a debounced pass. */
export const RESCAN_QUIET_MS = 120_000;

/**
 * STUB (#130): what the driver will do about a change, as `ScanDriver.touch`
 * answers: a pass at `scheduledAt` (ms), or one more after the pass running.
 */
export type ScanSchedule = { readonly scheduledAt: number } | { readonly afterCurrentPass: true };

/**
 * STUB (#130, `scanner/status.ts`): marks the library changed at `at`.
 * Stands in for the debounced `touch` by poking the driver now.
 */
async function markLibraryChanged(env: Env, at: number = Date.now()): Promise<ScanSchedule> {
  const outcome = await pokeScanDriver(env, at);

  return outcome === "running" ? { afterCurrentPass: true } : { scheduledAt: at };
}

/** STUB (#130, `scanner/state.ts`): the property the console's view reads. */
const LIBRARY_CHANGED_AT_KEY = "LibraryChangedAt";

/**
 * STUB (#130, `scanner/state.ts`): upserts `LibraryChangedAt = {"at": <ms>}`,
 * keeping the larger value, in one statement. A stored value that is not
 * JSON is replaced.
 */
async function writeLibraryChangedAt(db: Database, at: number): Promise<void> {
  const value = JSON.stringify({ at });
  await db
    .insert(property)
    .values({ id: LIBRARY_CHANGED_AT_KEY, value })
    .onConflictDoUpdate({
      target: property.id,
      set: { value },
      setWhere: sql`json_extract(excluded.value, '$.at') > coalesce(case when json_valid(${property.value}) then json_extract(${property.value}, '$.at') end, -1)`,
    });
}

/* ------------------------------------------- the module's own interface -- */

/** The schedule as the API answers it, with the instant as ISO 8601. */
export type ScanScheduleView =
  | { readonly scheduledAt: string }
  | { readonly afterCurrentPass: true };

/**
 * Records that the bucket changed at `changedAt` (computed once by the
 * route), and answers what the driver will do about it, or null when the
 * driver could not be told.
 */
export async function recordLibraryChange(
  env: Env,
  db: Database,
  changedAt: number,
): Promise<ScanScheduleView | null> {
  await writeLibraryChangedAt(db, changedAt);

  let schedule: ScanSchedule;
  try {
    schedule = await markLibraryChanged(env, changedAt);
  } catch (error) {
    console.error("files: the scan driver could not be told about a change", error);
    return null;
  }

  return "scheduledAt" in schedule
    ? { scheduledAt: new Date(schedule.scheduledAt).toISOString() }
    : { afterCurrentPass: true };
}
