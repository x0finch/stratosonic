/**
 * How the world outside the scan asks for a pass and reads what one is doing:
 * the rules `startScan` / `getScanStatus` (endpoints/scanning.ts) and the
 * console's overview (api/overview.ts) share, so the two can never disagree
 * about whether a scan is running or how far it has got (#82, "Server modules
 * and reuse").
 */

import { database } from "../db";
import type { Env } from "../env";
import {
  type PokeOutcome,
  RESCAN_QUIET_MS,
  SCAN_DRIVER_INSTANCE,
  type ScanSchedule,
} from "./driver";
import { type ScanCounts, type ScanReport, writeLibraryChangedAtStatement } from "./state";

export type { ScanSchedule } from "./driver";

/**
 * Whether either phase of a pass is running: the scan's own, which keeps a
 * `ScanProgress` row, or the playlist import that follows it, which keeps one
 * of its own after the scan's has been cleared (`ScanReport.importingPlaylists`).
 * Reading only the first would make a pass look finished several alarms
 * before it is.
 */
export function inFlight(report: ScanReport): boolean {
  return report.progress !== null || report.importingPlaylists;
}

/**
 * The tracks a pass has accounted for: `indexed + unchanged`, every track it
 * read again or skipped as unchanged. This is what `getScanStatus` reports as
 * `count`, as Navidrome reports media files, rather than `examined`, which
 * counts every object the bucket listed, covers and `.m3u` files included.
 */
export function tracksOf(counts: Pick<ScanCounts, "indexed" | "unchanged">): number {
  return counts.indexed + counts.unchanged;
}

/**
 * Pokes the scan driver, as the cron entry does (`index.ts`): it starts a
 * pass, or leaves the one in flight alone, and says which. `pokedAt` is the
 * instant a pass it starts is stamped with.
 *
 * The poke only arms the driver's first alarm, so a caller that reads the
 * scan's rows right after it finds no `ScanProgress` yet: either outcome
 * means a pass is running, and that is what a caller should report. A poke
 * that fails throws; whether that is swallowed (cron) or answered (a button)
 * is the caller's business.
 */
export function pokeScanDriver(env: Env, pokedAt: number = Date.now()): Promise<PokeOutcome> {
  return scanDriver(env).start(pokedAt);
}

/**
 * Marks the library changed at `at` (epoch milliseconds), after an upload
 * or a delete has changed the bucket, and answers what the scan driver will
 * do about it (#83, "Rescan after a change"). A route computes `at` once and
 * calls this after the bucket has changed.
 *
 * 1. It writes the `LibraryChangedAt` row, keeping the later instant
 *    (`writeLibraryChangedAtStatement`), so the console's poll reads the
 *    schedule from D1 (`scanSchedule`). A failed write throws: the files are
 *    changed, the route answers 500, and the cron catches up.
 * 2. It touches the driver, which starts one pass after the library has
 *    been quiet for `RESCAN_QUIET_MS`, or one more after the pass in
 *    flight. A failed touch is logged and answers null: the change stands,
 *    and the next cron pass, at most a quarter of an hour away, indexes it.
 *
 * One D1 statement and one Durable Object request.
 */
export async function markLibraryChanged(env: Env, at: number): Promise<ScanSchedule | null> {
  await writeLibraryChangedAtStatement(database(env), at);

  try {
    return await scanDriver(env).touch(at);
  } catch (error) {
    console.error(
      "scan driver: marking the library changed failed; the next cron pass indexes the change",
      error,
    );

    return null;
  }
}

/**
 * What the driver will do about the console's file changes, read from D1
 * alone, by the driver's own rule (`scanner/driver.ts`): a change is pending
 * when it was made at or after the start of the latest pass, the one in
 * flight or else the last completed one, or when no pass has ever run. A
 * pending change waits for the pass in flight, or starts one
 * `RESCAN_QUIET_MS` after it; a `scheduledAt` already past means the alarm
 * is due, or the pass it started has not written its first step yet.
 *
 * `running` and `passStartedAt` default to what the report says. A caller
 * that has just started a pass passes them, because the pass's first step
 * has not written anything yet (`POST /api/library/scan`).
 */
export function scanSchedule(
  report: ScanReport,
  running: boolean = inFlight(report),
  passStartedAt: number | null = latestPassStartedAt(report),
): ScanSchedule | null {
  const { lastChangedAt } = report;
  if (lastChangedAt === null || (passStartedAt !== null && lastChangedAt < passStartedAt)) {
    return null;
  }

  return running
    ? { scheduledAt: null, afterCurrentPass: true }
    : {
        scheduledAt: new Date(lastChangedAt + RESCAN_QUIET_MS).toISOString(),
        afterCurrentPass: false,
      };
}

/** The stamp of the pass in flight, or else of the last completed one. */
function latestPassStartedAt(report: ScanReport): number | null {
  return (
    report.progress?.startedAt ?? report.importStartedAt ?? report.lastCompleted?.startedAt ?? null
  );
}

function scanDriver(env: Env) {
  return env.SCAN_DRIVER.get(env.SCAN_DRIVER.idFromName(SCAN_DRIVER_INSTANCE));
}
