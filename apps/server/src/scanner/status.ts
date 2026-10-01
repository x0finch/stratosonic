/**
 * How the world outside the scan asks for a pass and reads what one is doing:
 * the rules `startScan` / `getScanStatus` (endpoints/scanning.ts) and the
 * console's overview (api/overview.ts) share, so the two can never disagree
 * about whether a scan is running or how far it has got (#82, "Server modules
 * and reuse").
 */

import type { Env } from "../env";
import { type PokeOutcome, SCAN_DRIVER_INSTANCE } from "./driver";
import type { ScanCounts, ScanReport } from "./state";

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
  return env.SCAN_DRIVER.get(env.SCAN_DRIVER.idFromName(SCAN_DRIVER_INSTANCE)).start(pokedAt);
}
