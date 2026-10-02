import type { Env } from "../env";
import { markLibraryChanged, type ScanSchedule } from "../scanner/status";

/**
 * Telling the library that the Files page changed the bucket (#83, "Rescan
 * after a change" and "The console's view is mirrored in D1"; ADR-0008): the
 * one place a file route does it, so that the scan picks the change up
 * without a **Scan now**.
 *
 * A route that changed the bucket calls `recordLibraryChange` once, after
 * the change, with the instant it computed once. That is the scan driver's
 * own `markLibraryChanged` (`scanner/status.ts`), which:
 *
 * 1. upserts the `LibraryChangedAt` property, never lowering it, so the
 *    console's live view can show the pending pass without asking the
 *    driver. A failed write throws, and the route answers 500: the files are
 *    changed, the console reports the error, and the cron catches up;
 * 2. touches the driver, which starts one pass `RESCAN_QUIET_MS` after the
 *    last change, or one more after the pass in flight. A failure there is
 *    logged and answered as null (`scan: null`), never as an error, since
 *    the files did change. null has no other meaning.
 *
 * An `at` in the future is taken as now. The routes add nothing to it: one
 * D1 statement and one Durable Object request per change.
 */

export { RESCAN_QUIET_MS } from "../scanner/driver";
export type { ScanSchedule } from "../scanner/status";

/**
 * Records that the bucket changed at `changedAt`, and answers what the
 * driver will do about it (`ScanSchedule`), or null when the driver could not
 * be told. A failed D1 write throws.
 */
export function recordLibraryChange(env: Env, changedAt: number): Promise<ScanSchedule | null> {
  return markLibraryChanged(env, changedAt);
}
