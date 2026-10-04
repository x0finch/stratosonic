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

import { DEFAULT_LIBRARY_ID, property } from "@stratosonic/db";
import { eq, inArray } from "drizzle-orm";
import type { Database } from "../db";
import { type RowsWritten, readRowsWritten, SCAN_ROWS_WRITTEN_KEY } from "../scanner/budget";
import { type ScanLibrary, scanLibrariesQuery } from "../scanner/state";

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
  /**
   * Playlists left out because their id is another library's row
   * (ADR-0009's collision): writing one would be refused, and would replace
   * the other playlist's entries (#84, "Entity ids").
   */
  broken: number;
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
    broken: 0,
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
  /**
   * The library the pass is in (#84, "Scanning several libraries"): the
   * import walks every active library in ascending id, as the scan does. A
   * row written before there were libraries has none, and means library 1.
   * The cursor, `skip`, `sweptTo` and `restarted` are that library's.
   */
  readonly libraryId: number;
  /** The R2 cursor that produces the page to resume in; `""` is the start. */
  readonly cursor: string;
  /** How many objects of that page the last run already handled. */
  readonly skip: number;
  /**
   * The last key the deletion sweep has cleared up to. Every playlist whose
   * key sorts at or below this has been seen, or deleted, in this pass.
   */
  readonly sweptTo: string;
  /**
   * Whether the listing was already restarted in this pass after the bucket
   * refused its cursor (`invalid_cursor`): it is restarted once (#84,
   * "Skipping a library").
   */
  readonly restarted: boolean;
  readonly counts: PlaylistImportCounts;
  /**
   * Progress rows this pass wrote that the day's write tally does not hold
   * yet; they join it when the pass ends (`scanner/budget.ts`).
   */
  readonly untallied: RowsWritten | null;
}

/** What one import run reads before it starts, in one round trip. */
export interface PlaylistImportState {
  readonly progress: PlaylistImportProgress | null;
  /** The day's write tally the import counts against (`scanner/budget.ts`). */
  readonly rowsWritten: RowsWritten | null;
  /**
   * Every library row, in ascending id: the ones to walk (the active ones),
   * how to reach each (`storageFor`), and every path an entry may name.
   */
  readonly libraries: readonly ScanLibrary[];
}

/**
 * The import's progress, the day's write tally and the library rows, in one
 * batch: one round trip, one subrequest, as the scan reads its own
 * (`readScanState`), so each step sees each library's current `state`.
 */
export async function readPlaylistImportState(db: Database): Promise<PlaylistImportState> {
  const [rows, libraries] = await db.batch([
    db
      .select()
      .from(property)
      .where(inArray(property.id, [PLAYLIST_IMPORT_PROGRESS_KEY, SCAN_ROWS_WRITTEN_KEY])),
    scanLibrariesQuery(db),
  ]);
  const stored = new Map(rows.map((row) => [row.id, parsedObject(row.value)]));

  return {
    progress: readProgress(stored.get(PLAYLIST_IMPORT_PROGRESS_KEY) ?? null),
    rowsWritten: readRowsWritten(stored.get(SCAN_ROWS_WRITTEN_KEY) ?? undefined),
    libraries,
  };
}

/** The progress of a pass in flight, or null when none is. */
export async function readPlaylistImportProgress(
  db: Database,
): Promise<PlaylistImportProgress | null> {
  const rows = await db
    .select()
    .from(property)
    .where(eq(property.id, PLAYLIST_IMPORT_PROGRESS_KEY));

  return readProgress(rows[0] === undefined ? null : (parsedObject(rows[0].value) ?? null));
}

function parsedObject(value: string): Record<string, unknown> | undefined {
  if (value === "") {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readProgress(stored: Record<string, unknown> | null): PlaylistImportProgress | null {
  if (stored === null) {
    return null;
  }

  const startedAt = wholeNumber(stored.startedAt);
  const counts = readCounts(stored.counts);
  if (startedAt === null || counts === null) {
    return null;
  }

  return {
    startedAt,
    libraryId: positiveWholeNumber(stored.libraryId) ?? DEFAULT_LIBRARY_ID,
    cursor: typeof stored.cursor === "string" ? stored.cursor : "",
    skip: wholeNumber(stored.skip) ?? 0,
    sweptTo: typeof stored.sweptTo === "string" ? stored.sweptTo : "",
    restarted: stored.restarted === true,
    counts,
    untallied: readRowsWritten(
      typeof stored.untallied === "object" && stored.untallied !== null
        ? (stored.untallied as Record<string, unknown>)
        : undefined,
    ),
  };
}

/** Writes the progress, as a statement for the page's batch. */
export function writePlaylistImportProgressStatement(
  db: Database,
  progress: PlaylistImportProgress,
) {
  const value = JSON.stringify(progress);

  return db
    .insert(property)
    .values({ id: PLAYLIST_IMPORT_PROGRESS_KEY, value })
    .onConflictDoUpdate({ target: property.id, set: { value } });
}

/** Clears the progress at the end of a pass, as a statement for a batch. */
export function clearPlaylistImportProgressStatement(db: Database) {
  return db.delete(property).where(eq(property.id, PLAYLIST_IMPORT_PROGRESS_KEY));
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

function positiveWholeNumber(value: unknown): number | null {
  const whole = wholeNumber(value);
  return whole === null || whole === 0 ? null : whole;
}

function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}
