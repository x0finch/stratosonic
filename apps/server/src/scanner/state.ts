/**
 * What one scan leaves behind between cron runs, in the `property` table.
 *
 * A scan is bounded: a run indexes a fixed amount of the bucket and stops, and
 * the next run picks up where it left off. Two rows carry that across runs, in
 * the key/value table Navidrome keeps its own scan state in
 * (`consts.LastScanStartTimeKey` and friends):
 *
 * - **`ScanProgress`** exists only while a pass is in flight. It holds the R2
 *   listing cursor to resume from, how far into that page the last run got,
 *   how far the deletion sweep has advanced, and the counts so far.
 * - **`LastScanSummary`** is written when a pass completes, and replaced by
 *   the next one. `getIndexes`' `lastModified` and the scan-status reporting
 *   read it; nothing else should have to know these key names, which is why
 *   the accessors below are the module's interface rather than the keys.
 *
 * Both hold JSON rather than a bare value, so one read and one write carry the
 * whole state: D1 writes are the budget a free-tier cron has least of. A row
 * that cannot be parsed is treated as absent - a scan that starts over is
 * always correct, while a scan that trusts a half-written cursor is not.
 */

import { property } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import type { Database } from "../db";

/** The row a pass in flight writes. */
const SCAN_PROGRESS_KEY = "ScanProgress";

/** The row a completed pass writes. */
const LAST_SCAN_SUMMARY_KEY = "LastScanSummary";

/** What a pass has done so far, or did in total. */
export interface ScanCounts {
  /** Objects the listing offered and the scan looked at, music or not. */
  examined: number;
  /** Tracks whose bytes were read and whose rows were written. */
  indexed: number;
  /** Of those, ones the library did not have before. */
  added: number;
  /** Of those, ones whose stored etag and size no longer matched. */
  updated: number;
  /** Tracks skipped because their etag and size still matched. */
  unchanged: number;
  /** Objects whose bytes could not be read; counted, never retried harder. */
  broken: number;
  /** Objects R2 could not produce; left for the next run to try again. */
  deferred: number;
  /** Cover objects written to `_covers/`. */
  coversWritten: number;
  /** Tracks whose R2 object was gone, removed by the sweep. */
  removed: number;
  /** Albums left with no tracks and pruned. */
  albumsRemoved: number;
  /** Artists left with no albums and pruned. */
  artistsRemoved: number;
}

export function noCounts(): ScanCounts {
  return {
    examined: 0,
    indexed: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    broken: 0,
    deferred: 0,
    coversWritten: 0,
    removed: 0,
    albumsRemoved: 0,
    artistsRemoved: 0,
  };
}

export function addCounts(into: ScanCounts, from: ScanCounts): void {
  for (const key of Object.keys(into) as (keyof ScanCounts)[]) {
    into[key] += from[key];
  }
}

/** A pass that has not finished, as the next run needs to find it. */
export interface ScanProgress {
  /** Epoch milliseconds the pass began at. */
  readonly startedAt: number;
  /** The R2 cursor that produces the page to resume in; `""` is the start. */
  readonly cursor: string;
  /** How many objects of that page the last run already handled. */
  readonly skip: number;
  /**
   * The last key the deletion sweep has cleared up to. Every track whose key
   * sorts at or below this has been seen, or deleted, in this pass.
   */
  readonly sweptTo: string;
  readonly counts: ScanCounts;
}

/** A pass that finished. */
export interface ScanSummary {
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly counts: ScanCounts;
}

/** The progress of a pass in flight, or null when none is. */
export async function readScanProgress(db: Database): Promise<ScanProgress | null> {
  const stored = await readProperty(db, SCAN_PROGRESS_KEY);
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
    cursor: typeof stored.cursor === "string" ? stored.cursor : "",
    skip: wholeNumber(stored.skip) ?? 0,
    sweptTo: typeof stored.sweptTo === "string" ? stored.sweptTo : "",
    counts,
  };
}

export async function writeScanProgress(db: Database, progress: ScanProgress): Promise<void> {
  await writeProperty(db, SCAN_PROGRESS_KEY, progress);
}

export async function clearScanProgress(db: Database): Promise<void> {
  await db.delete(property).where(eq(property.id, SCAN_PROGRESS_KEY));
}

/** The last pass that ran to completion, or null when none has. */
export async function readLastScanSummary(db: Database): Promise<ScanSummary | null> {
  const stored = await readProperty(db, LAST_SCAN_SUMMARY_KEY);
  if (stored === null) {
    return null;
  }

  const startedAt = wholeNumber(stored.startedAt);
  const finishedAt = wholeNumber(stored.finishedAt);
  const counts = readCounts(stored.counts);
  if (startedAt === null || finishedAt === null || counts === null) {
    return null;
  }

  return { startedAt, finishedAt, counts };
}

export async function writeLastScanSummary(db: Database, summary: ScanSummary): Promise<void> {
  await writeProperty(db, LAST_SCAN_SUMMARY_KEY, summary);
}

/**
 * When the library last finished changing, as `getIndexes`' `lastModified`
 * reports it: the end of the last completed pass, or null before the first
 * one. A pass in flight does not count - half a library is not a state a
 * client should be told to cache against.
 */
export async function lastScanFinishedAt(db: Database): Promise<Date | null> {
  const summary = await readLastScanSummary(db);

  return summary === null ? null : new Date(summary.finishedAt);
}

/** A stored JSON object, or null when the row is missing or unreadable. */
async function readProperty(db: Database, id: string): Promise<Record<string, unknown> | null> {
  const rows = await db.select().from(property).where(eq(property.id, id)).limit(1);
  const value = rows[0]?.value;
  if (value === undefined || value === "") {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);

    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function writeProperty(db: Database, id: string, value: unknown): Promise<void> {
  await db
    .insert(property)
    .values({ id, value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: property.id, set: { value: JSON.stringify(value) } });
}

/**
 * Counts as they were stored. A field the stored row does not carry - because
 * a later version added it - reads as zero rather than voiding the whole row.
 */
function readCounts(value: unknown): ScanCounts | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const stored = value as Record<string, unknown>;
  const counts = noCounts();
  for (const key of Object.keys(counts) as (keyof ScanCounts)[]) {
    counts[key] = wholeNumber(stored[key]) ?? 0;
  }

  return counts;
}

function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}
