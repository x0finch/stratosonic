/**
 * How the world outside the scan asks for a pass and reads what one is doing:
 * the rules `startScan` / `getScanStatus` (endpoints/scanning.ts) and the
 * console's overview (api/overview.ts) share, so the two can never disagree
 * about whether a scan is running or how far it has got (#82, "Server modules
 * and reuse").
 */

import { database } from "../db";
import type { Env } from "../env";
import { budgetReached, nextUtcMidnight, rowsWrittenOn, utcDay } from "./budget";
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
 *    flight.
 *
 * It answers the driver's schedule: a time a pass starts, one more pass
 * after the one in flight, or `{ scheduledAt: null, afterCurrentPass:
 * false }` when the pass in flight began after the change and covers it.
 * It answers null only when the touch failed, which is logged: the change
 * stands, and the next cron pass, at most a quarter of an hour away,
 * indexes it. An `at` in the future is taken as now, so a wrong clock
 * cannot hold the pass off.
 *
 * One D1 statement and one Durable Object request.
 */
export async function markLibraryChanged(env: Env, at: number): Promise<ScanSchedule | null> {
  const changedAt = Math.min(at, Date.now());
  await writeLibraryChangedAtStatement(database(env), changedAt);

  try {
    return await scanDriver(env).touch(changedAt);
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
 * is due, or the pass it started has not written its first step yet. A
 * change the pass in flight covers reads as null here, as no change does:
 * the view says nothing is pending, so it never gives `touch`'s third
 * answer.
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

/** Why the scan is not running though a pass may be due: the daily write budget. */
export interface ScanPause {
  readonly reason: "daily_write_budget";
  /** When the pause ends: the next 00:00 UTC, an ISO 8601 instant. */
  readonly until: string;
}

/**
 * Whether the scan is paused at the daily write budget (`scanner/budget.ts`),
 * read from D1 alone: the day's tally has reached `budget`. Every cron poke
 * stops at its first step until the next UTC day, which this says. Null with
 * no cap (`budget` 0) or while the day's rows are under it.
 */
export function scanPause(report: ScanReport, budget: number, now: number): ScanPause | null {
  if (!budgetReached(rowsWrittenOn(report.rowsWritten, utcDay(now)), budget)) {
    return null;
  }

  return { reason: "daily_write_budget", until: new Date(nextUtcMidnight(now)).toISOString() };
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
