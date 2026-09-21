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
 * `startScan` cannot read them, though: the poke only arms the driver's first
 * alarm, and the `ScanProgress` row does not exist until that alarm's step
 * writes it a second later. It reports `scanning="true"` from what the poke
 * itself says instead — the driver either started a pass or found one already
 * in flight, and both mean a pass is running.
 */

import { database } from "../db";
import { SCAN_DRIVER_INSTANCE } from "../scanner/driver";
import { readScanReport, type ScanReport } from "../scanner/state";
import type { SubsonicNode } from "../subsonic/response";
import type { SubsonicHandler } from "../subsonic/router";

/**
 * `getScanStatus` — whether a pass is in flight, and how much it has looked
 * at. A server that has never scanned answers `scanning="false" count="0"`
 * rather than an error: a client polls this, and the honest answer to "is a
 * scan running" on a fresh database is "no".
 */
export const getScanStatus: SubsonicHandler = async (request) => {
  const report = await readScanReport(database(request.env));

  return { scanStatus: scanStatusElement(report, report.progress !== null) };
};

/**
 * `startScan` — pokes the scan driver exactly as the cron `scheduled` handler
 * does (`index.ts`), then answers the status.
 *
 * A poke while a pass is in flight is a no-op, so pressing the button twice
 * does not restart a pass or rewind the instant it is stamped with; the
 * answer is the same either way, which is what a client asking to scan wants
 * to hear.
 */
export const startScan: SubsonicHandler = async (request) => {
  const driver = request.env.SCAN_DRIVER.get(
    request.env.SCAN_DRIVER.idFromName(SCAN_DRIVER_INSTANCE),
  );
  await driver.start(Date.now());

  return { scanStatus: scanStatusElement(await readScanReport(database(request.env)), true) };
};

/**
 * The `<scanStatus>` element, attribute for attribute as Navidrome declares
 * it (`responses.ScanStatus`).
 *
 * `count` is what the pass in flight has examined so far, or what the last
 * completed pass examined, or zero — the running total a client watches climb.
 * `lastScan` is the end of the last completed pass, omitted before there has
 * been one, as Navidrome's pointer field is. `folderCount` is left out: this
 * server has one music folder and the scan does not count directories, and an
 * invented zero would only mislead a client that shows it.
 */
function scanStatusElement(report: ScanReport, scanning: boolean): SubsonicNode {
  const { progress, lastCompleted } = report;

  return {
    scanning,
    count: (progress ?? lastCompleted)?.counts.examined ?? 0,
    lastScan: lastCompleted === null ? undefined : new Date(lastCompleted.finishedAt).toISOString(),
  };
}
