/**
 * The Media library scanning module: the two endpoints a client — or an
 * administrator — uses to ask for a scan and to watch one.
 *
 * Both are admin-only, as they are in Navidrome
 * (server/subsonic/library_scanning.go, mounted inside the `adminOnly` group
 * in server/subsonic/api.go): a scan is a server-wide operation, so a
 * listener gets error 50 rather than a way to make the server work.
 *
 * The two answer the same element. Navidrome's `StartScan` starts its scan
 * and then returns `getScanStatus`'s own response, so a client learns from
 * one round trip that the scan is under way; this module does the same.
 *
 * ## Where the answer comes from
 *
 * A scan here is not a goroutine with a status object in memory: the pass is
 * driven by a Durable Object and what it has done lives in D1's `property`
 * table (ADR-0004 as amended by #31, `scanner/state.ts`). So `getScanStatus`
 * reads those rows and nothing else — one query, no call into the driver —
 * which is both what the state is for and what the free plan's subrequest
 * budget prefers.
 *
 * A pass is two phases, and both of them count as scanning: the scan's own
 * pass, which keeps a `ScanProgress` row, and the playlist import that
 * follows it, which keeps one of its own after the scan's has been cleared
 * (`ScanReport.importingPlaylists`). Reading only the first would make a pass
 * look finished several alarms before it is. One alarm of that — the second
 * between the scan's last step and the import's first, where neither row
 * exists — is not closable from D1 at all, and costs a polling client one
 * early `false`.
 *
 * `startScan` cannot read either of them, though: the poke only arms the
 * driver's first alarm, and the `ScanProgress` row does not exist until that
 * alarm's step writes it a second later. It reports `scanning="true"` from
 * what the poke itself says instead — the driver either started a pass or
 * found one already in flight, and both mean a pass is running.
 *
 * ## What `count` counts
 *
 * Navidrome reports media files: the files scanned so far while a scan is
 * running, and the library's song count when none is. So `count` here is
 * `indexed + unchanged` — every track the pass has accounted for, read again
 * or skipped as unchanged — rather than the scan's `examined`, which counts
 * every object the bucket listed, cover art and `.m3u` files included, and
 * would tell a client the library holds more songs than it does.
 */

import { database } from "../db";
import { SCAN_DRIVER_INSTANCE } from "../scanner/driver";
import { readScanReport, type ScanReport } from "../scanner/state";
import type { SubsonicNode } from "../subsonic/response";
import type { SubsonicHandler } from "../subsonic/router";

/**
 * `getScanStatus` — whether a pass is in flight, and how many tracks it has
 * accounted for. A server that has never scanned answers `scanning="false"
 * count="0"` rather than an error: a client polls this, and the honest answer
 * to "is a scan running" on a fresh database is "no".
 */
export const getScanStatus: SubsonicHandler = async (request) => {
  const report = await readScanReport(database(request.env));

  return { scanStatus: scanStatusElement(report, inFlight(report)) };
};

/**
 * `startScan` — pokes the scan driver exactly as the cron `scheduled` handler
 * does (`index.ts`), then answers the status.
 *
 * A poke while a pass is in flight is a no-op, so pressing the button twice
 * does not restart a pass or rewind the instant it is stamped with; the
 * answer is the same either way, which is what a client asking to scan wants
 * to hear.
 *
 * A poke that *fails* is not swallowed here, unlike in the cron entry: cron
 * has a next run to poke again with and nobody watching this one, whereas an
 * administrator who pressed the button is owed the generic error rather than
 * a `scanning="true"` that is not true.
 */
export const startScan: SubsonicHandler = async (request) => {
  const driver = request.env.SCAN_DRIVER.get(
    request.env.SCAN_DRIVER.idFromName(SCAN_DRIVER_INSTANCE),
  );
  const outcome = await driver.start(Date.now());
  console.log(
    outcome === "started"
      ? "startScan: a pass has started"
      : "startScan: a pass is already running",
  );

  return { scanStatus: scanStatusElement(await readScanReport(database(request.env)), true) };
};

/** Whether either phase of a pass is running. */
function inFlight(report: ScanReport): boolean {
  return report.progress !== null || report.importingPlaylists;
}

/**
 * The `<scanStatus>` element, attribute for attribute as Navidrome declares
 * it (`responses.ScanStatus`).
 *
 * `count` is read from whichever pass the status is about: the one in flight
 * while there is one, and the last completed one otherwise. A pass that has
 * just been armed and has written nothing says 0 rather than borrowing the
 * previous pass's total, which would have a client watching the number fall
 * as the new pass caught up with it. The import phase is the exception: the
 * scan half of *this* pass has already finished and written its summary, so
 * that summary is the count, and the number a client watches climbs to the
 * library's total and stays there rather than dipping to 0 for the second
 * half of the pass.
 *
 * `lastScan` is the end of the last completed pass, omitted before there has
 * been one, as Navidrome's pointer field is; it stays what it is during a
 * pass, because that is what the attribute means. `folderCount` is left out:
 * this server has one music folder and the scan does not count directories,
 * and an invented zero would only mislead a client that shows it.
 */
function scanStatusElement(report: ScanReport, scanning: boolean): SubsonicNode {
  const { progress, importingPlaylists, lastCompleted } = report;
  const counted = scanning
    ? (progress ?? (importingPlaylists ? lastCompleted : null))
    : lastCompleted;

  return {
    scanning,
    count: counted === null ? 0 : counted.counts.indexed + counted.counts.unchanged,
    lastScan: lastCompleted === null ? undefined : new Date(lastCompleted.finishedAt).toISOString(),
  };
}
