import { property } from "@stratosonic/db";
import { sql } from "drizzle-orm";
import { database } from "../db";
import type { Env } from "../env";
import { pokeScanDriver } from "../scanner/status";

/**
 * Telling the library that the Files page changed the bucket (#83, "Rescan
 * after a change" and "The console's view is mirrored in D1"): the one place
 * a file route does it, so that the scan picks the change up without a
 * **Scan now**.
 *
 * A route that changed the bucket calls `recordLibraryChange` once, after
 * the change, which is `markLibraryChanged`:
 *
 * 1. it upserts the `LibraryChangedAt` property, never lowering it, so the
 *    console's live view can show the pending pass without asking the
 *    driver. A failed write throws, and the route answers 500: the files are
 *    changed, the console reports the error, and the cron catches up;
 * 2. it marks the library changed in the scan driver, which debounces the
 *    pass. A failure there is logged and answered as null (`scan: null`),
 *    never as an error, since the files did change.
 *
 * ---------------------------------------------------------------------------
 * STUB: replace with #130's exports at merge.
 *
 * Ticket A (#130, PR #137) owns `markLibraryChanged` and `ScanSchedule`
 * (`scanner/status.ts`) and `RESCAN_QUIET_MS` (`scanner/driver.ts`). The
 * stand-ins below have the same signatures, types and D1 write. At the
 * merge, delete them and import #130's instead; `recordLibraryChange` and
 * every route stay as they are.
 *
 * Until then, the stand-in `markLibraryChanged` pokes the driver as **Scan
 * now** does, so a change starts a pass at once rather than after the quiet
 * window, and a change during a pass queues no follow-up (the next cron pass
 * covers it).
 * ---------------------------------------------------------------------------
 */

/** STUB (#130, `scanner/driver.ts`): the quiet window before a debounced pass. */
export const RESCAN_QUIET_MS = 120_000;

/** STUB (#130, `scanner/driver.ts`): what the driver will do about a change. */
export type ScanSchedule =
  /** A pass starts at about this time, once the library has stayed quiet. */
  | { readonly scheduledAt: string; readonly afterCurrentPass: false }
  /** A pass is running, and one more follows it for the change. */
  | { readonly scheduledAt: null; readonly afterCurrentPass: true };

/**
 * STUB (#130, `scanner/status.ts`): writes `LibraryChangedAt` (throws on a
 * D1 failure), then tells the driver (logs, and answers null, on a failure).
 * Stands in for the debounced `touch` by poking the driver now.
 */
async function markLibraryChanged(env: Env, at: number): Promise<ScanSchedule | null> {
  await writeLibraryChangedAt(env, at);

  try {
    const outcome = await pokeScanDriver(env, at);
    return outcome === "running"
      ? { scheduledAt: null, afterCurrentPass: true }
      : { scheduledAt: new Date(at).toISOString(), afterCurrentPass: false };
  } catch (error) {
    console.error(
      "scan driver: marking the library changed failed; the next cron pass indexes the change",
      error,
    );
    return null;
  }
}

/**
 * STUB (#130, `scanner/state.ts: writeLibraryChangedAtStatement`): upserts
 * `LibraryChangedAt = {"at": <ms>}`, keeping the later of it and the stored
 * one, in one statement. A stored row that will not parse is replaced.
 */
async function writeLibraryChangedAt(env: Env, at: number): Promise<void> {
  const value = JSON.stringify({ at });
  await database(env)
    .insert(property)
    .values({ id: "LibraryChangedAt", value })
    .onConflictDoUpdate({
      target: property.id,
      set: { value },
      setWhere: sql`${at} > case when json_valid(${property.value})
        then case when json_type(${property.value}, '$.at') in ('integer', 'real')
          then json_extract(${property.value}, '$.at') else -1 end
        else -1 end`,
    });
}

/* ------------------------------------------- the module's own interface -- */

/**
 * Records that the bucket changed at `changedAt` (computed once by the
 * route), and answers what the driver will do about it, or null when the
 * driver could not be told. A failed D1 write throws.
 */
export function recordLibraryChange(env: Env, changedAt: number): Promise<ScanSchedule | null> {
  return markLibraryChanged(env, changedAt);
}
