/**
 * What one scan leaves behind between cron runs, in the `property` table.
 *
 * A scan is bounded: a run indexes a fixed amount of the bucket and stops, and
 * the next run picks up where it left off. Three rows carry that across runs,
 * in the key/value table Navidrome keeps its own scan state in
 * (`consts.LastScanStartTimeKey` and friends):
 *
 * - **`ScanProgress`** exists only while a pass is in flight. It holds the R2
 *   listing cursor to resume from, how far into that page the last run got,
 *   how far the deletion sweep has advanced, and the counts so far.
 * - **`LastScanSummary`** is written when a pass completes, and replaced by
 *   the next one. `getIndexes`' `lastModified` and the scan-status reporting
 *   read it; nothing else should have to know these key names, which is why
 *   the accessors below are the module's interface rather than the keys.
 * - **`BrokenObjects`** remembers, by key and etag, the objects whose bytes
 *   could not be read, so a permanently broken file is read once rather than
 *   once every pass.
 *
 * Each row holds JSON rather than a bare value, and the reads take several
 * keys at a time, so a run's whole state costs one query in and one statement
 * out. That matters more than it looks: on the free plan a D1 query is a
 * *subrequest*, and an invocation only has fifty of them.
 *
 * Every write is offered as a **statement** as well, so the scan can commit a
 * page's rows and its own cursor in one batch. A cursor that advanced without
 * the rows it stands for - or rows without the cursor - is the one piece of
 * corruption a resumable scan cannot repair by itself.
 *
 * A row that cannot be parsed is treated as absent: a scan that starts over is
 * always correct, while a scan that trusts a half-written cursor is not.
 */

import { property } from "@stratosonic/db";
import { eq, inArray } from "drizzle-orm";
import type { Database } from "../db";
import type { ScanStatement } from "./repository";

/** The row a pass in flight writes. */
const SCAN_PROGRESS_KEY = "ScanProgress";

/** The row a completed pass writes. */
const LAST_SCAN_SUMMARY_KEY = "LastScanSummary";

/** The row that remembers which objects are not worth reading again. */
const BROKEN_OBJECTS_KEY = "BrokenObjects";

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
  /** Objects whose bytes are not readable audio, read or remembered. */
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

/** The two added together, as a new set of counts. */
export function addedCounts(left: ScanCounts, right: ScanCounts): ScanCounts {
  const total = noCounts();
  for (const key of Object.keys(total) as (keyof ScanCounts)[]) {
    total[key] = left[key] + right[key];
  }

  return total;
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

/**
 * The objects whose bytes could not be read, by key, each remembered with the
 * etag it was broken at.
 *
 * An object stays here only as long as its bytes do not change: a file that is
 * re-uploaded has a different etag, is no longer a match, and is read again.
 * The scan drops an entry whose key the bucket no longer lists, in the same
 * interval walk the deletion sweep uses, so the memo cannot grow without
 * bound.
 */
export type BrokenObjects = Map<string, string>;

/** Everything one run needs to read before it starts. */
export interface ScanState {
  readonly progress: ScanProgress | null;
  readonly broken: BrokenObjects;
}

/** The state of a scan in one query. */
export async function readScanState(db: Database): Promise<ScanState> {
  const stored = await readProperties(db, [SCAN_PROGRESS_KEY, BROKEN_OBJECTS_KEY]);

  return {
    progress: readProgress(stored.get(SCAN_PROGRESS_KEY)),
    broken: readBroken(stored.get(BROKEN_OBJECTS_KEY)),
  };
}

/** The progress of a pass in flight, or null when none is. */
export async function readScanProgress(db: Database): Promise<ScanProgress | null> {
  return readProgress((await readProperties(db, [SCAN_PROGRESS_KEY])).get(SCAN_PROGRESS_KEY));
}

/** The last pass that ran to completion, or null when none has. */
export async function readLastScanSummary(db: Database): Promise<ScanSummary | null> {
  return readSummary(
    (await readProperties(db, [LAST_SCAN_SUMMARY_KEY])).get(LAST_SCAN_SUMMARY_KEY),
  );
}

/** The objects currently written off as unreadable. */
export async function readBrokenObjects(db: Database): Promise<BrokenObjects> {
  return readBroken((await readProperties(db, [BROKEN_OBJECTS_KEY])).get(BROKEN_OBJECTS_KEY));
}

export function writeScanProgressStatement(db: Database, progress: ScanProgress): ScanStatement {
  return writeStatement(db, SCAN_PROGRESS_KEY, progress);
}

export function writeLastScanSummaryStatement(db: Database, summary: ScanSummary): ScanStatement {
  return writeStatement(db, LAST_SCAN_SUMMARY_KEY, summary);
}

export function writeBrokenObjectsStatement(db: Database, broken: BrokenObjects): ScanStatement {
  return writeStatement(db, BROKEN_OBJECTS_KEY, Object.fromEntries(broken));
}

export function clearScanProgressStatement(db: Database): ScanStatement {
  return db.delete(property).where(eq(property.id, SCAN_PROGRESS_KEY));
}

/**
 * When the most recent scan began, whether or not it has finished, or null
 * before the first one.
 *
 * This is what `getIndexes` dates the library with: Navidrome reads its own
 * `LastScanStartTime` property there (`getArtist` in
 * server/subsonic/browsing.go) rather than the finish, because a client that
 * sends the instant back in `ifModifiedSince` must not be told the library is
 * older than anything a scan in flight is still writing.
 */
export async function lastScanStartedAt(db: Database): Promise<Date | null> {
  const stored = await readProperties(db, [SCAN_PROGRESS_KEY, LAST_SCAN_SUMMARY_KEY]);
  const inFlight = readProgress(stored.get(SCAN_PROGRESS_KEY));
  if (inFlight !== null) {
    return new Date(inFlight.startedAt);
  }

  const summary = readSummary(stored.get(LAST_SCAN_SUMMARY_KEY));

  return summary === null ? null : new Date(summary.startedAt);
}

/**
 * When the library last finished changing: the end of the last completed
 * pass, or null before there has been one. A pass in flight does not count -
 * half a library is not a state anything should report as settled.
 */
export async function lastScanFinishedAt(db: Database): Promise<Date | null> {
  const summary = await readLastScanSummary(db);

  return summary === null ? null : new Date(summary.finishedAt);
}

/* --------------------------------------------------------- the rows -- */

/** Several stored JSON objects in one query, by key; unreadable ones absent. */
async function readProperties(
  db: Database,
  ids: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const rows = await db
    .select()
    .from(property)
    .where(inArray(property.id, [...ids]));

  const found = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const parsed = parseObject(row.value);
    if (parsed !== null) {
      found.set(row.id, parsed);
    }
  }

  return found;
}

function writeStatement(db: Database, id: string, value: unknown): ScanStatement {
  const serialized = JSON.stringify(value);

  return db
    .insert(property)
    .values({ id, value: serialized })
    .onConflictDoUpdate({ target: property.id, set: { value: serialized } });
}

function parseObject(value: string): Record<string, unknown> | null {
  if (value === "") {
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

function readProgress(stored: Record<string, unknown> | undefined): ScanProgress | null {
  if (stored === undefined) {
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

function readSummary(stored: Record<string, unknown> | undefined): ScanSummary | null {
  if (stored === undefined) {
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

function readBroken(stored: Record<string, unknown> | undefined): BrokenObjects {
  const broken: BrokenObjects = new Map();
  for (const [key, etag] of Object.entries(stored ?? {})) {
    if (typeof etag === "string") {
      broken.set(key, etag);
    }
  }

  return broken;
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
