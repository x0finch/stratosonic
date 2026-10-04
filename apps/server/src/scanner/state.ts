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
 *   once every pass. It is library 1's memo; every other library has its own,
 *   `BrokenObjects:<id>` (#84, "Scanning several libraries").
 *
 * A pass walks every active library in turn, in ascending id, so
 * `ScanProgress` also says which library its cursor belongs to. A row written
 * by v0.5.0 names none, and means library 1, so a pass in flight resumes
 * across the deploy.
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

import { DEFAULT_LIBRARY_ID, type Library, library, property } from "@stratosonic/db";
import { asc, eq, inArray, like, or, sql } from "drizzle-orm";
import type { Database } from "../db";
import { PLAYLIST_IMPORT_PROGRESS_KEY } from "../playlists/state";
import { type RowsWritten, readRowsWritten, SCAN_ROWS_WRITTEN_KEY } from "./budget";
import type { ScanStatement } from "./repository";

/** The row a pass in flight writes. */
const SCAN_PROGRESS_KEY = "ScanProgress";

/** The row a completed pass writes. */
const LAST_SCAN_SUMMARY_KEY = "LastScanSummary";

/** The row that remembers which objects of library 1 are not worth reading again. */
const BROKEN_OBJECTS_KEY = "BrokenObjects";

/** The memo of a library's broken objects: library 1's keeps v0.5.0's key. */
export function brokenObjectsKey(libraryId: number): string {
  return libraryId === DEFAULT_LIBRARY_ID
    ? BROKEN_OBJECTS_KEY
    : `${BROKEN_OBJECTS_KEY}:${libraryId}`;
}

/** The library a memo key belongs to, or null for a key that is no memo. */
function libraryOfBrokenObjectsKey(key: string): number | null {
  if (key === BROKEN_OBJECTS_KEY) {
    return DEFAULT_LIBRARY_ID;
  }
  const match = /^BrokenObjects:([1-9][0-9]{0,15})$/.exec(key);

  return match === null ? null : Number(match[1]);
}

/**
 * The row the console's file routes write after an upload or delete:
 * `{"at": <epoch ms>}`, the latest change. It mirrors the change the scan
 * driver keeps (`scanner/driver.ts`, `pending`), so the console reads what
 * the driver will do from D1, without a Durable Object request (#83).
 */
const LIBRARY_CHANGED_AT_KEY = "LibraryChangedAt";

/** What a pass has done so far, or did in total. */
export interface ScanCounts {
  /**
   * Steps the pass has taken, this one included: always 1 for a single run,
   * and for a whole pass however many the driver had to chain (#31).
   */
  steps: number;
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
    steps: 0,
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

/** What a pass has done in each library, by library id. */
export type LibraryCounts = Readonly<Record<string, ScanCounts>>;

/** A pass that has not finished, as the next run needs to find it. */
export interface ScanProgress {
  /** Epoch milliseconds the pass began at. */
  readonly startedAt: number;
  /**
   * The library the cursor belongs to. The pass resumes in the first active
   * library whose id is at least this, so a library that is gone, or being
   * removed, is left with its cursor, and an id past every library means
   * every library has been listed. A v0.5.0 row has none: library 1.
   */
  readonly libraryId: number;
  /** The storage cursor that produces the page to resume in; `""` is the start. */
  readonly cursor: string;
  /** How many objects of that page the last run already handled. */
  readonly skip: number;
  /**
   * The last key the deletion sweep has cleared up to. Every track whose key
   * sorts at or below this has been seen, or deleted, in this pass.
   */
  readonly sweptTo: string;
  /**
   * Whether this library's listing was already restarted in this pass after
   * the storage refused its cursor (`invalid_cursor`): it is restarted once,
   * and a second refusal is a failure like any other.
   */
  readonly restarted: boolean;
  /** What the whole pass has done so far, every library together. */
  readonly counts: ScanCounts;
  /** The same, library by library. */
  readonly libraries: LibraryCounts;
  /**
   * Rows this pass wrote that the day's tally (`ScanRowsWritten`) does not
   * hold yet: the progress rows of pages that wrote nothing else. They ride
   * in this row, which every page writes anyway, and join the tally with
   * the next batch that writes more than its progress, so an unchanged
   * page costs one row written, not two (`scanner/budget.ts`).
   */
  readonly untallied: RowsWritten | null;
}

/** A pass that finished. */
export interface ScanSummary {
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly counts: ScanCounts;
  /** What the pass did in each library it scanned, by library id. */
  readonly libraries: LibraryCounts;
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

/** What a step reads of a library row: where its bucket is, and whether it is served. */
export type ScanLibrary = Pick<
  Library,
  "id" | "name" | "kind" | "path" | "endpoint" | "bucket" | "credentials" | "state"
>;

/** Everything one run needs to read before it starts. */
export interface ScanState {
  readonly progress: ScanProgress | null;
  /** Each library's memo, by library id; a library with none is absent. */
  readonly broken: ReadonlyMap<number, BrokenObjects>;
  /** The day's write tally (`scanner/budget.ts`). */
  readonly rowsWritten: RowsWritten | null;
  /** Every library row, in ascending id, so a step sees each one's `state`. */
  readonly libraries: readonly ScanLibrary[];
}

/**
 * The state of a scan and the library rows, in one batch: one round trip,
 * one subrequest (#84, "The step budget, recomputed for S3"). Every memo is
 * read, one row per library, so a step that moves to the next library has
 * its memo already.
 */
export async function readScanState(db: Database): Promise<ScanState> {
  const [rows, libraries] = await db.batch([
    db
      .select()
      .from(property)
      .where(
        or(
          inArray(property.id, [SCAN_PROGRESS_KEY, SCAN_ROWS_WRITTEN_KEY, BROKEN_OBJECTS_KEY]),
          like(property.id, `${BROKEN_OBJECTS_KEY}:%`),
        ),
      ),
    scanLibrariesQuery(db),
  ]);
  const stored = parsedProperties(rows);
  const broken = new Map<number, BrokenObjects>();
  for (const [key, value] of stored) {
    const libraryId = libraryOfBrokenObjectsKey(key);
    if (libraryId !== null) {
      broken.set(libraryId, readBroken(value));
    }
  }

  return {
    progress: readProgress(stored.get(SCAN_PROGRESS_KEY)),
    broken,
    rowsWritten: readRowsWritten(stored.get(SCAN_ROWS_WRITTEN_KEY)),
    libraries,
  };
}

/**
 * The libraries' names and states, in ascending id: what the console's live
 * view needs to say which library a pass is in (`scanLibraryPosition`), as a
 * statement for its batch.
 */
export function libraryNamesQuery(db: Database) {
  return db
    .select({ id: library.id, name: library.name, state: library.state })
    .from(library)
    .orderBy(asc(library.id));
}

/** The library a pass in flight is scanning, as the console shows it. */
export interface ScanLibraryPosition {
  readonly id: number;
  readonly name: string;
  /** Its place among the active libraries, from 1. */
  readonly index: number;
  /** How many libraries are active. */
  readonly of: number;
}

/**
 * Which library the scan in flight is in, by the rule the scan resumes by
 * (the first active library whose id is at least the progress row's), or
 * null when no scan is in flight or every library has been listed.
 */
export function scanLibraryPosition(
  progress: ScanProgress | null,
  libraries: readonly Pick<Library, "id" | "name" | "state">[],
): ScanLibraryPosition | null {
  if (progress === null) {
    return null;
  }
  const active = libraries.filter((row) => row.state === "active");
  const index = active.findIndex((row) => row.id >= progress.libraryId);
  const current = active[index];

  return current === undefined
    ? null
    : { id: current.id, name: current.name, index: index + 1, of: active.length };
}

/** Every library row a step needs, in ascending id, as a statement for a batch. */
export function scanLibrariesQuery(db: Database) {
  return db
    .select({
      id: library.id,
      name: library.name,
      kind: library.kind,
      path: library.path,
      endpoint: library.endpoint,
      bucket: library.bucket,
      credentials: library.credentials,
      state: library.state,
    })
    .from(library)
    .orderBy(asc(library.id));
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

/**
 * What a pass has done, as something outside the scan sees it: the scan in
 * flight, whether the import that follows it is in flight, and the last pass
 * that completed.
 *
 * `getScanStatus` needs all three — whether anything is running, and what the
 * last pass did when nothing is — and one query is one subrequest, which on
 * the free plan is the unit that matters.
 */
export interface ScanReport {
  readonly progress: ScanProgress | null;
  /**
   * Whether the playlist import is in flight. It is the second half of a
   * pass (#31), and it runs *after* the scan's own pass has finished and
   * cleared `ScanProgress`, so without this a pass in its import phase would
   * look finished.
   */
  readonly importingPlaylists: boolean;
  /**
   * When the import in flight began, which is the pass's own stamp; null
   * when none is in flight, or its row will not parse.
   */
  readonly importStartedAt: number | null;
  readonly lastCompleted: ScanSummary | null;
  /** When the console last changed a file in the bucket, or null if it never has. */
  readonly lastChangedAt: number | null;
  /** The day's write tally, which says whether the scan is paused (`scanner/budget.ts`). */
  readonly rowsWritten: RowsWritten | null;
  /**
   * The rows the import in flight carries for the tally in its progress row
   * (the scan's are `progress.untallied`), or null.
   */
  readonly importUntallied: RowsWritten | null;
}

/** Everything a pass shows the outside world, in one query. */
export async function readScanReport(db: Database): Promise<ScanReport> {
  return toScanReport(await scanReportQuery(db));
}

/**
 * `readScanReport`'s statement, unrun, for a caller that sends it in a
 * `db.batch` with others (the console's overview, api/overview.ts);
 * `toScanReport` reads what it returns.
 */
export function scanReportQuery(db: Database) {
  return propertiesQuery(db, [
    SCAN_PROGRESS_KEY,
    PLAYLIST_IMPORT_PROGRESS_KEY,
    LAST_SCAN_SUMMARY_KEY,
    LIBRARY_CHANGED_AT_KEY,
    SCAN_ROWS_WRITTEN_KEY,
  ]);
}

/** The rows `scanReportQuery` returns, as `readScanReport` answers them. */
export function toScanReport(rows: Awaited<ReturnType<typeof scanReportQuery>>): ScanReport {
  const stored = parsedProperties(rows);
  const importing = stored.get(PLAYLIST_IMPORT_PROGRESS_KEY);

  return {
    progress: readProgress(stored.get(SCAN_PROGRESS_KEY)),
    // Only whether the row is there, and when its pass began: what the
    // import has done is its own module's business, and a row that will not
    // parse is treated as absent here as everywhere else in this module.
    importingPlaylists: importing !== undefined,
    importStartedAt: importing === undefined ? null : wholeNumber(importing.startedAt),
    lastCompleted: readSummary(stored.get(LAST_SCAN_SUMMARY_KEY)),
    lastChangedAt: wholeNumber(stored.get(LIBRARY_CHANGED_AT_KEY)?.at),
    rowsWritten: readRowsWritten(stored.get(SCAN_ROWS_WRITTEN_KEY)),
    importUntallied:
      typeof importing?.untallied === "object" && importing.untallied !== null
        ? readRowsWritten(importing.untallied as Record<string, unknown>)
        : null,
  };
}

/**
 * Records a change to the bucket at `at`, keeping the later of it and the
 * stored one, so two requests that race cannot move the instant back. A
 * stored row that will not parse is replaced.
 */
export function writeLibraryChangedAtStatement(db: Database, at: number): ScanStatement {
  const value = JSON.stringify({ at });

  return db
    .insert(property)
    .values({ id: LIBRARY_CHANGED_AT_KEY, value })
    .onConflictDoUpdate({
      target: property.id,
      set: { value },
      setWhere: sql`${at} > case when json_valid(${property.value})
        then case when json_type(${property.value}, '$.at') in ('integer', 'real')
          then json_extract(${property.value}, '$.at') else -1 end
        else -1 end`,
    });
}

/** The objects of a library currently written off as unreadable. */
export async function readBrokenObjects(
  db: Database,
  libraryId: number = DEFAULT_LIBRARY_ID,
): Promise<BrokenObjects> {
  const key = brokenObjectsKey(libraryId);

  return readBroken((await readProperties(db, [key])).get(key));
}

export function writeScanProgressStatement(db: Database, progress: ScanProgress): ScanStatement {
  return writeStatement(db, SCAN_PROGRESS_KEY, progress);
}

export function writeLastScanSummaryStatement(db: Database, summary: ScanSummary): ScanStatement {
  return writeStatement(db, LAST_SCAN_SUMMARY_KEY, summary);
}

export function writeBrokenObjectsStatement(
  db: Database,
  libraryId: number,
  broken: BrokenObjects,
): ScanStatement {
  return writeStatement(db, brokenObjectsKey(libraryId), Object.fromEntries(broken));
}

export function deleteBrokenObjectsStatement(db: Database, libraryId: number): ScanStatement {
  return db.delete(property).where(eq(property.id, brokenObjectsKey(libraryId)));
}

export function clearScanProgressStatement(db: Database): ScanStatement {
  return db.delete(property).where(eq(property.id, SCAN_PROGRESS_KEY));
}

/**
 * The statements that start a library's scan over, for a change of its
 * bucket (#84, "Scanning several libraries": a `PATCH` that changes a
 * library's bucket resets its cursor, if the pass is in it, and its memo, in
 * the same batch). The pass then lists the new bucket from its start, and
 * sweeps the tracks it no longer holds.
 */
export function resetLibraryScanStatements(db: Database, libraryId: number): ScanStatement[] {
  // A v0.5.0 row names no library, and is library 1's.
  const ofThisLibrary = sql`coalesce(json_extract(${property.value}, '$.libraryId'), ${DEFAULT_LIBRARY_ID}) = ${libraryId}`;

  return [
    db
      .update(property)
      .set({
        value: sql`json_set(${property.value}, '$.cursor', '', '$.skip', 0, '$.sweptTo', '', '$.restarted', json('false'))`,
      })
      .where(
        sql`${property.id} = ${SCAN_PROGRESS_KEY} and json_valid(${property.value}) and ${ofThisLibrary}`,
      ),
    deleteBrokenObjectsStatement(db, libraryId),
  ];
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
  const { progress, lastCompleted } = await readScanReport(db);
  if (progress !== null) {
    return new Date(progress.startedAt);
  }

  return lastCompleted === null ? null : new Date(lastCompleted.startedAt);
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
  return parsedProperties(await propertiesQuery(db, ids));
}

function propertiesQuery(db: Database, ids: readonly string[]) {
  return db
    .select()
    .from(property)
    .where(inArray(property.id, [...ids]));
}

function parsedProperties(
  rows: Awaited<ReturnType<typeof propertiesQuery>>,
): Map<string, Record<string, unknown>> {
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

  const libraryId = wholeNumber(stored.libraryId);

  return {
    startedAt,
    // v0.5.0 wrote no library: its pass was in library 1.
    libraryId: libraryId === null || libraryId < 1 ? DEFAULT_LIBRARY_ID : libraryId,
    cursor: typeof stored.cursor === "string" ? stored.cursor : "",
    skip: wholeNumber(stored.skip) ?? 0,
    sweptTo: typeof stored.sweptTo === "string" ? stored.sweptTo : "",
    restarted: stored.restarted === true,
    counts,
    libraries: readLibraryCounts(stored.libraries),
    untallied: readRowsWritten(
      typeof stored.untallied === "object" && stored.untallied !== null
        ? (stored.untallied as Record<string, unknown>)
        : undefined,
    ),
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

  return { startedAt, finishedAt, counts, libraries: readLibraryCounts(stored.libraries) };
}

/** Per-library counts as stored; an entry that will not parse is left out. */
function readLibraryCounts(value: unknown): LibraryCounts {
  const found: Record<string, ScanCounts> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return found;
  }
  for (const [id, stored] of Object.entries(value)) {
    const counts = readCounts(stored);
    if (/^[1-9][0-9]{0,15}$/.test(id) && counts !== null) {
      found[id] = counts;
    }
  }

  return found;
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
