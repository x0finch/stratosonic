/**
 * What one playlist-import pass leaves behind between cron runs, in the
 * `property` table.
 *
 * The import is bounded for the same reason the scan is (`scanner/state.ts`):
 * a run does a fixed amount of work and stops, and the next run resumes from
 * the cursor this row carries. The state is written **after every page**, not
 * only at the end of a run, so an invocation the platform kills mid-pass
 * cannot make the next one start over and grind through the same pages for
 * ever.
 *
 * The row holds JSON, so one read and one write carry the whole state. A row
 * that cannot be parsed is treated as absent: a pass that starts over is
 * always correct, while a pass that trusts a half-written cursor is not.
 */

import { property } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import type { Database } from "../db";

/**
 * The row a pass in flight writes.
 *
 * It is exported because it is the other half of the answer to "is a scan
 * running": the driver runs the import after the scan's own pass has finished
 * and cleared `ScanProgress` (#31), so `scanner/state.ts` reads this key
 * alongside its own and `getScanStatus` still costs one query.
 */
export const PLAYLIST_IMPORT_PROGRESS_KEY = "PlaylistImportProgress";

/** What a pass has done so far. */
export interface PlaylistImportCounts {
  /**
   * Steps the pass has taken, this one included: always 1 for a single run,
   * and for a whole pass however many the driver had to chain (#31).
   */
  steps: number;
  /** Objects the listing offered and the import looked at, playlist or not. */
  examined: number;
  /** Playlists read from the bucket and made to agree with the library. */
  imported: number;
  /**
   * How many of those needed no writing at all, because the library already
   * held exactly what the file resolved to. The ordinary case on every pass
   * after the first, and the reason a quiet library costs no rows written.
   */
  unchanged: number;
  /** Entries that named a track; what the playlist holds once resolved. */
  entries: number;
  /** Entry paths that named no track; skipped, never fatal. */
  unmatched: number;
  /** Objects R2 could not produce; left for the next run to try again. */
  deferred: number;
  /** Playlists whose `.m3u` object has gone, removed by the sweep. */
  removed: number;
}

export function noPlaylistImportCounts(): PlaylistImportCounts {
  return {
    steps: 0,
    examined: 0,
    imported: 0,
    unchanged: 0,
    entries: 0,
    unmatched: 0,
    deferred: 0,
    removed: 0,
  };
}

export function addPlaylistImportCounts(
  into: PlaylistImportCounts,
  from: PlaylistImportCounts,
): void {
  for (const key of Object.keys(into) as (keyof PlaylistImportCounts)[]) {
    into[key] += from[key];
  }
}

/** A pass that has not finished, as the next run needs to find it. */
export interface PlaylistImportProgress {
  /** Epoch milliseconds the pass began at. */
  readonly startedAt: number;
  /** The R2 cursor that produces the page to resume in; `""` is the start. */
  readonly cursor: string;
  /** How many objects of that page the last run already handled. */
  readonly skip: number;
  /**
   * The last key the deletion sweep has cleared up to. Every playlist whose
   * key sorts at or below this has been seen, or deleted, in this pass.
   */
  readonly sweptTo: string;
  readonly counts: PlaylistImportCounts;
}

/** The progress of a pass in flight, or null when none is. */
export async function readPlaylistImportProgress(
  db: Database,
): Promise<PlaylistImportProgress | null> {
  const rows = await db
    .select()
    .from(property)
    .where(eq(property.id, PLAYLIST_IMPORT_PROGRESS_KEY))
    .limit(1);

  const value = rows[0]?.value;
  if (value === undefined || value === "") {
    return null;
  }

  let stored: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    stored = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const startedAt = wholeNumber(stored.startedAt);
  const counts = readCounts(stored.counts);
  if (startedAt === null || counts === null) {
    return null;
  }

  return {
    startedAt,
    cursor: typeof stored.cursor === "string" ? stored.cursor : "",
    skip: wholeNumber(stored.skip) ?? 0,
    sweptTo: typeof stored.sweptTo === "string" ? stored.sweptTo : "",
    counts,
  };
}

export async function writePlaylistImportProgress(
  db: Database,
  progress: PlaylistImportProgress,
): Promise<void> {
  const value = JSON.stringify(progress);

  await db
    .insert(property)
    .values({ id: PLAYLIST_IMPORT_PROGRESS_KEY, value })
    .onConflictDoUpdate({ target: property.id, set: { value } });
}

export async function clearPlaylistImportProgress(db: Database): Promise<void> {
  await db.delete(property).where(eq(property.id, PLAYLIST_IMPORT_PROGRESS_KEY));
}

/**
 * Counts as they were stored. A field the stored row does not carry -
 * because a later version added it - reads as zero rather than voiding the
 * whole row.
 */
function readCounts(value: unknown): PlaylistImportCounts | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const stored = value as Record<string, unknown>;
  const counts = noPlaylistImportCounts();
  for (const key of Object.keys(counts) as (keyof PlaylistImportCounts)[]) {
    counts[key] = wholeNumber(stored[key]) ?? 0;
  }

  return counts;
}

function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}
