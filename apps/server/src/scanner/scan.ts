/**
 * The Scan: the scheduled pass that keeps D1 in step with every library's
 * bucket.
 *
 * Music arrives in a bucket out of band, with rclone, as
 * `artist/album/title.ext` (ADR-0004). Nothing tells the server when. So the
 * scan walks each bucket, reads the header of each audio object it has not
 * seen before, and writes the Artists, Albums and Tracks it finds; tracks
 * whose object has gone are removed, and albums and artists left with nothing
 * are pruned.
 *
 * One call of `runScan` is one step. The steps are driven by the scan driver
 * (`scanner/driver.ts`), a Durable Object whose alarm runs a step and
 * schedules the next about a second later until the pass completes; the cron
 * trigger only pokes it (#31). Nothing below changes because of that - an
 * alarm invocation is a Worker invocation, with the same subrequest budget -
 * except that the steps now run back to back rather than a quarter of an hour
 * apart.
 *
 * ## Several libraries (#84, "Scanning several libraries"; ADR-0009)
 *
 * A pass has Navidrome's phase-by-phase shape (`scanner/scanner.go`):
 *
 * 1. the cleanup of libraries being removed (`scanner/cleanup.ts`), one
 *    bounded batch a step, before anything is scanned;
 * 2. the scan of each `active` library in ascending id, each from its own
 *    cursor, in its own bucket (`storageFor`);
 * 3. one prune, since artists are shared;
 * 4. the playlist import, which the driver runs after this (`playlists/`).
 *
 * Every step reads the scan's state and the library rows in one batch, so it
 * sees each library's current `state`: a library set `removing` mid-pass is
 * left at the next step, with its cursor and no sweep. When a library's
 * listing ends, the page's batch moves the pass to the next library and
 * stamps both (`last_scan_at`, `last_scan_started_at`).
 *
 * **Only a failed `list` judges a library.** Refused credentials or a
 * missing bucket skip it at once, with `last_scan_error`; a refused cursor
 * restarts its listing once; anything else (throttling, an outage) is a
 * `LibraryListingError` the driver retries with its backoff and, after
 * `maxFailures`, skips (`skipLibrary`). A failed read of one object stays that
 * object's `deferred`, as it always was. **Nothing is swept from a library
 * that was not listed**: the sweep only ever removes rows inside a listed
 * page's interval.
 *
 * Covers, whatever library their track is in, go to the bound bucket's
 * `_covers/` (#84, "Covers"), and only library 1's listing hides that prefix.
 *
 * ## The budget a run has
 *
 * On the Workers free plan an invocation may make **50 subrequests**, and a
 * subrequest is "any request a Worker makes using the Fetch API **or to
 * Cloudflare services like R2, KV, or D1**"
 * (developers.cloudflare.com/workers/platform/limits, "Subrequests"). The
 * separate allowance of 1,000 "subrequests to internal services" is a second
 * ceiling, not a way round the first. A step runs in a Durable Object alarm
 * (`scanner/driver.ts`), where the Durable Objects limits table allows **30
 * seconds of CPU per request** with no plan split; the 10 ms of CPU the free
 * plan gives a *cron* invocation now only has to cover the poke. #30
 * confirms both against a real deployment.
 *
 * Fifty calls is what the limits below are derived from. Worst case for one
 * run, with the defaults, for the bound bucket and for an S3 library alike,
 * since an S3 call is one `fetch` as the binding call it replaces is one
 * subrequest (#84, "The step budget, recomputed for S3"):
 *
 * | what | calls |
 * | --- | --- |
 * | read the scan's state and the library rows (one batch) | 1 |
 * | 3 pages x (`list`, interval query, page-rows query, write batch) | 12 |
 * | 6 extractions x 3 range reads (measured in #21) | 18 |
 * | up to 6 cover `put`s, to the bound bucket | 6 |
 * | completing a pass: 3 prunes, one bulk cover delete, one summary batch | 5 |
 * | moving to the next library (in the page's batch) | 0 |
 * | **total** | **42** |
 *
 * The eight calls of headroom are deliberate: three range reads per track is
 * what #21 measured on these formats, not a guarantee - a track carrying a
 * megabyte of artwork needs more chunks - and a page whose sweep deletes more
 * than one statement can bind adds a statement, not a call, but an unusual
 * page could still cost a little more than the table says. The `fetch` share
 * of an S3 step is at most 21 (3 listings and 18 range reads).
 *
 * Everything a page does goes into **one batch**, including the cursor and
 * the day's write tally (`scanner/budget.ts`), so a run that is killed - by
 * the CPU limit, which cannot be caught, or by a subrequest it could not
 * afford - loses at most the page it was in the middle of. That is the whole
 * reason the budget can be an estimate rather than a proof.
 *
 * ## The daily write budget
 *
 * A step that finds the day's tally at `SCAN_DAILY_WRITE_BUDGET` does
 * nothing and answers `paused`, and a step that reaches it stops before its
 * next page; the driver then ends the pass as a give-up does, and the next
 * UTC day resumes from the cursor (`scanner/budget.ts`).
 *
 * ## What the driver adds to that
 *
 * Nothing, on this side of it. The driver's own bookkeeping - one storage
 * read, one storage write, and the `setAlarm` that follows a step - is local
 * to the Durable Object, and Durable Object storage is not a subrequest. What
 * it costs is counted in the other free-plan ceilings, per step:
 *
 * | what a step costs the driver | |
 * | --- | --- |
 * | subrequests | 0 of the 50 above |
 * | Durable Object requests, the alarm itself | 1 of 100,000 a day |
 * | rows read | 1 of 5,000,000 a day |
 * | rows written, the state row and `setAlarm` | 2 of 100,000 a day |
 *
 * The cron invocation, which used to run a step itself, now spends one
 * subrequest on the poke and returns.
 *
 * ## What that costs in wall-clock time
 *
 * Six tracks a step, a step a second, is 5,000 tracks in about 840 steps and
 * **a quarter of an hour** - a first full index that used to take nine days
 * at one step per cron tick (#31). A rescan of an unchanged 5,000 walks 270
 * objects a step, about nineteen steps, and is over in half a minute,
 * because an unchanged object costs no read of its own.
 *
 * Those 840 alarms are 840 of the free plan's 100,000 Durable Object
 * requests a day, and a step's 128 MB-second or so is nothing against 13,000
 * GB-s. What is left of ADR-0004's remedy is the subrequest limit itself:
 * Workers Paid raises it to 10,000, which turns a step into thousands of
 * tracks. A bigger batch on the free plan would simply fail.
 */

import { DEFAULT_LIBRARY_ID } from "@stratosonic/db";
import { type Database, database } from "../db";
import type { Env } from "../env";
import { isAudioKey, suffixOf } from "../library/audio-formats";
import { storageSource } from "../library/byte-source";
import {
  type EmbeddedCover,
  extractMetadata,
  MetadataError,
  type TrackMetadata,
} from "../library/metadata";
import { boundStorage } from "../storage/binding";
import { storageFor } from "../storage/for-library";
import {
  type LibraryStorage,
  type StorageFailure,
  type StorageListing,
  type StoredObject,
  UnaddressableKeyError,
} from "../storage/storage";
import {
  budgetReached,
  countedBatch,
  dailyWriteBudget,
  flushLedger,
  type RowLedger,
  rowsWrittenOn,
  tallyStatement,
  utcDay,
  WORST_ROWS_PER_INDEXED_TRACK,
} from "./budget";
import { cleanUpLibrary } from "./cleanup";
import { coverKeyFor, isCoverKey } from "./covers";
import { type DerivedRows, deriveRows, type LibraryObject } from "./derive";
import { LibraryListingError, listingFailure, skipsAtOnce } from "./listing-failure";
import {
  deleteTracksStatements,
  findPageRows,
  findTracksInRange,
  type LibraryStamp,
  lyricsStatement,
  pruneEmptyAlbums,
  pruneEmptyArtists,
  pruneOrphanPlaylistEntries,
  recomputeAlbumStatement,
  type ScanStatement,
  type StoredTrack,
  setAlbumCoverStatement,
  stampLibraryStatement,
  upsertStatements,
} from "./repository";
import {
  addedCounts,
  type BrokenObjects,
  clearScanProgressStatement,
  type LibraryCounts,
  noCounts,
  readScanState,
  type ScanCounts,
  type ScanLibrary,
  type ScanProgress,
  writeBrokenObjectsStatement,
  writeLastScanSummaryStatement,
  writeScanProgressStatement,
} from "./state";
import { SCAN_VERSION } from "./version";

/** How much of the bucket one run gets through. See the budget above. */
export interface ScanLimits {
  /** Objects per `list()`. */
  readonly pageSize: number;
  /** Listing pages one run may walk: the cheap path's bound. */
  readonly pagesPerRun: number;
  /** Objects whose bytes one run may read: the expensive path's bound. */
  readonly extractionsPerRun: number;
  /** Tracks one page's sweep may remove before it leaves the rest. */
  readonly deletionsPerPage: number;
}

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  pageSize: 90,
  pagesPerRun: 3,
  extractionsPerRun: 6,
  deletionsPerPage: 90,
};

/** What a run is given beyond its stamp and limits. */
export interface ScanOptions {
  /**
   * The day's D1 write budget, `0` for no cap. Production passes nothing and
   * the run reads `SCAN_DAILY_WRITE_BUDGET` (`dailyWriteBudget`); the tests
   * inject a small one.
   */
  readonly writeBudget?: number;
  /**
   * The wall clock, which says what UTC day the budget is counted in. Not
   * the run's stamp: a pass resumed the next day keeps its old stamp and is
   * counted against the new day.
   */
  readonly clock?: () => number;
  /**
   * The rows earlier steps wrote that neither the tally nor a progress row
   * holds yet (`scanner/budget.ts`). The run adds the rows of its own
   * batches as it puts these on the tally or in the progress row, and leaves
   * the rest - its last batch's - here for the driver to carry to the next
   * step, even when it throws.
   */
  readonly ledger?: RowLedger;
}

/** What one run of the scan did. */
export interface ScanRun {
  /** Whether the pass finished: every library was listed or skipped, and the prune ran. */
  readonly completed: boolean;
  /** Whether the run stopped at the daily write budget (`scanner/budget.ts`). */
  readonly paused: boolean;
  /** Epoch milliseconds the pass - not this run - began at. */
  readonly startedAt: number;
  /** What this run alone did. */
  readonly counts: ScanCounts;
  /** What the whole pass has done, this run included. */
  readonly totals: ScanCounts;
}

/** A track read in this run, waiting to be written. */
interface Extracted {
  readonly rows: DerivedRows;
  readonly cover: EmbeddedCover | undefined;
  /** The row the library held for it, if any. */
  readonly held: StoredTrack | undefined;
  /** The etag the object was read at. */
  readonly etag: string;
  /** Whether the library already held this track with different bytes. */
  readonly changed: boolean;
}

/** What one listed object turns out to need. */
type Plan =
  /** Not music: artwork, a playlist, a stray file. */
  | { readonly work: "ignore" }
  /** Its etag and size still match the row we hold, read by this scanner version. */
  | { readonly work: "unchanged" }
  /** Known unreadable at exactly these bytes; not worth a read. */
  | { readonly work: "known-broken" }
  | {
      readonly work: "read";
      readonly object: LibraryObject;
      readonly held: StoredTrack | undefined;
    };

/**
 * A library-1 key that could hash to another library's track id: one that
 * begins with a library id's digits and U+200B (ADR-0009). Any key of
 * another library could collide with such a library-1 key, so every one of
 * those is asked about.
 */
const COLLISION_SHAPED = /^[1-9][0-9]*​/;

/**
 * Runs one bounded step of the scan and reports what it did.
 *
 * `now` is the instant the run is stamped with - the time the pass was poked
 * at in production, a fixed value in a test. It is what every row's `updatedAt`
 * becomes, what a library's scan stamps record, and what a completed pass
 * records as its finish, so a run is a function of its inputs rather than of
 * the clock (the budget's day aside, `ScanOptions.clock`).
 *
 * A single object that cannot be read never ends a run: bytes that are not
 * what their suffix promised are counted as broken, remembered against their
 * etag so they are not read again, and passed over; a storage failure is
 * counted as deferred and left for the next run, which will find the object
 * unknown and try again.
 */
export async function runScan(
  env: Env,
  now: Date = new Date(),
  limits: ScanLimits = DEFAULT_SCAN_LIMITS,
  options: ScanOptions = {},
): Promise<ScanRun> {
  const db = database(env);
  const covers = boundStorage(env);
  const budget = options.writeBudget ?? dailyWriteBudget(env);
  const day = utcDay((options.clock ?? Date.now)());
  const state = await readScanState(db);
  const previous = state.progress;
  // Today's rows the tally does not hold yet, carried in the progress row; a
  // carry from another day counts against that day, which is over.
  let untallied = rowsWrittenOn(previous?.untallied ?? null, day);
  const ledger = options.ledger ?? { rows: 0 };
  // Every row of today the scan knows of: on the tally, carried in the
  // progress row, and in the ledger.
  let spent = rowsWrittenOn(state.rowsWritten, day) + untallied + ledger.rows;

  const startedAt = previous?.startedAt ?? now.getTime();
  const before = previous?.counts ?? noCounts();
  const counts = noCounts();
  counts.steps = 1;
  const libraryTotals = copied(previous?.libraries ?? {});
  const ran = (completed: boolean, paused: boolean): ScanRun => ({
    completed,
    paused,
    startedAt,
    counts,
    totals: addedCounts(before, counts),
  });

  // The day's budget is spent: nothing is read or written, and the driver
  // ends the pass until the next UTC day.
  if (budgetReached(spent, budget)) {
    console.warn(`scan: paused until tomorrow, ${spent} of ${budget} rows written today`);
    await flushLedger(db, day, ledger);

    return ran(false, true);
  }

  // Phase 1: a library being removed is deleted first, one bounded batch a
  // step, before anything is scanned.
  // Library 1 is the bound bucket and is never removed (ADR-0009): whatever
  // its row says, nothing of it is cleaned up.
  const removing = state.libraries.find(
    (row) => row.state === "removing" && row.id !== DEFAULT_LIBRARY_ID,
  );
  if (removing !== undefined) {
    await cleanUpLibrary(db, covers, removing.id, day, ledger);

    return ran(false, false);
  }

  // Phase 2: the library the pass is in, from its own cursor. One that is no
  // longer active is left with its cursor: nothing of it is swept.
  const active = state.libraries.filter((row) => row.state === "active");
  const wanted = previous?.libraryId ?? DEFAULT_LIBRARY_ID;
  let current = firstActiveFrom(active, wanted);
  const resumes = previous !== null && current !== null && current.id === previous.libraryId;
  let cursor = resumes ? previous.cursor : "";
  let skip = resumes ? previous.skip : 0;
  let sweptTo = resumes ? previous.sweptTo : "";
  let restarted = resumes ? previous.restarted : false;
  // Where the progress points once every library has been left.
  let past = wanted;
  // A library the pass enters at the start of this step is stamped by its
  // first batch; one it enters below is stamped by the batch that left the
  // one before.
  let unstamped = current !== null && !resumes;
  const memos = new Map(state.broken);
  const storages = new Map<number, LibraryStorage>();
  const touched = new Set<number>();
  let extractions = 0;
  let paused = false;

  const progress = (): ScanProgress => ({
    startedAt,
    libraryId: current?.id ?? past,
    cursor,
    skip,
    sweptTo,
    restarted,
    counts: addedCounts(before, counts),
    libraries: libraryTotals,
    untallied: untallied === 0 ? null : { day, rows: untallied },
  });

  /**
   * Leaves the library the pass is in for the next active one, whose entry
   * is stamped in the same batch.
   */
  const moveOn = (stamps: Stamps): void => {
    const left = current;
    if (left === null) {
      return;
    }
    past = left.id + 1;
    current = firstActiveFrom(active, past);
    cursor = "";
    skip = 0;
    sweptTo = "";
    restarted = false;
    unstamped = false;
    if (current !== null) {
      stamp(stamps, current.id, { lastScanStartedAt: now });
    }
  };

  /**
   * Commits a page in one batch: its statements, its library stamps (one
   * statement a library) and the pass's progress. The rows written so far
   * and not yet on the tally go with it: a page that writes tracks puts them
   * on the tally, and one that writes only bookkeeping carries them in the
   * progress row (`ScanProgress.untallied`), so an unchanged pass writes the
   * tally once, at its end. The batch's own rows, as D1 reports them, go to
   * the ledger, for the next write to carry.
   */
  const commit = async (
    writes: ScanStatement[],
    stamps: Stamps,
    writesTracks: boolean,
  ): Promise<void> => {
    for (const [libraryId, fields] of stamps) {
      writes.push(stampLibraryStatement(db, libraryId, fields));
    }
    if (writesTracks) {
      if (untallied + ledger.rows > 0) {
        writes.push(tallyStatement(db, day, untallied + ledger.rows));
      }
      untallied = 0;
    } else {
      untallied += ledger.rows;
    }
    ledger.rows = 0;
    writes.push(writeScanProgressStatement(db, progress()));
    const rows = await countedBatch(db, writes);
    ledger.rows += rows;
    spent += rows;
  };

  /** A page's counts, into the step's and its library's. */
  const addPage = (libraryId: number, page: ScanCounts): void => {
    const steps = touched.has(libraryId) ? 0 : 1;
    touched.add(libraryId);
    for (const key of Object.keys(counts) as (keyof ScanCounts)[]) {
      if (key !== "steps") {
        counts[key] += page[key];
      }
    }
    const into = countsOf(libraryTotals, libraryId);
    for (const key of Object.keys(into) as (keyof ScanCounts)[]) {
      into[key] += key === "steps" ? steps : page[key];
    }
  };

  for (let page = 0; page < limits.pagesPerRun && current !== null; page++) {
    // Room for the page itself: the measured worst case for each track the
    // step may still read, so one page cannot overshoot by much.
    const headroom =
      WORST_ROWS_PER_INDEXED_TRACK *
      Math.max(0, Math.min(limits.extractionsPerRun - extractions, limits.pageSize));
    if (budgetReached(spent + headroom, budget)) {
      console.warn(`scan: paused until tomorrow, ${spent} of ${budget} rows written today`);
      paused = true;
      break;
    }

    const library: ScanLibrary = current;
    const writes: ScanStatement[] = [];
    const stamps: Stamps = new Map();
    if (unstamped) {
      stamp(stamps, library.id, { lastScanStartedAt: now });
      unstamped = false;
    }

    let storage: LibraryStorage;
    let listing: StorageListing;
    try {
      storage = storages.get(library.id) ?? storageFor(env, library);
      storages.set(library.id, storage);
      listing = await storage.list({
        limit: limits.pageSize,
        ...(cursor === "" ? {} : { cursor }),
      });
    } catch (error) {
      const reason = listingFailure(error);
      if (skipsAtOnce(reason)) {
        // The key was refused, or the bucket is gone: the library is
        // skipped for this pass at once, with its tracks kept.
        console.warn(`scan: skipping library ${library.id} for this pass (${reason})`, error);
        stamp(stamps, library.id, { lastScanError: reason });
        moveOn(stamps);
        await commit(writes, stamps, false);
        continue;
      }
      if (reason === "invalid_cursor" && cursor !== "" && !restarted) {
        // A stale continuation token: the library's listing starts over,
        // once. The sweep starts over with it, so nothing is skipped.
        console.warn(`scan: library ${library.id} refused its cursor; listing it again`, error);
        cursor = "";
        skip = 0;
        sweptTo = "";
        restarted = true;
        await commit(writes, stamps, false);
        continue;
      }
      throw new LibraryListingError(
        library.id,
        reason === "invalid_cursor" ? "unavailable" : reason,
        { cause: error },
      );
    }

    const memo = memos.get(library.id) ?? new Map<string, string>();
    memos.set(library.id, memo);
    let memoChanged = false;
    const pageCounts = noCounts();
    const objects = listing.objects;
    const listedKeys = new Set(objects.map(keyOf));
    const lastKey = objects.at(-1)?.key;
    const through = listing.cursor !== null ? (lastKey ?? sweptTo) : null;

    // One query serves both of this page's questions: which of its objects
    // the library already holds, and which rows in the stretch of the key
    // space it covers belong to objects that are gone.
    const inRange = await findTracksInRange(
      db,
      library.id,
      sweptTo,
      through,
      limits.pageSize + limits.deletionsPerPage,
    );
    const missing = inRange.filter((row) => !listedKeys.has(row.r2Key));

    // An interval holding more rows than the query would return says nothing
    // reliable about which of this page's objects are held - the window may
    // not even reach them - so the backlog of deletions is cleared first and
    // the page is indexed on a later run, from the same cursor.
    if (inRange.length >= limits.pageSize + limits.deletionsPerPage) {
      const removing = missing.slice(0, limits.deletionsPerPage);
      pageCounts.removed += removing.length;
      writes.push(
        ...deleteTracksStatements(
          db,
          removing.map((row) => row.id),
        ),
        ...[...new Set(removing.map((row) => row.albumId))].map((id) =>
          recomputeAlbumStatement(db, id, now),
        ),
      );
      addPage(library.id, pageCounts);
      await commit(writes, stamps, removing.length > 0);
      break;
    }

    const held = new Map(inRange.map((row) => [row.r2Key, row]));
    const extracted: Extracted[] = [];
    let position = skip;
    let interrupted = false;

    for (; position < objects.length; position++) {
      const object = objects[position];
      if (object === undefined) {
        continue;
      }

      const planned = planFor(object, held, memo, library.id);
      if (planned.work === "read" && extractions >= limits.extractionsPerRun) {
        interrupted = true;
        break;
      }

      pageCounts.examined++;

      if (planned.work === "ignore") {
        continue;
      }
      if (planned.work === "unchanged") {
        pageCounts.unchanged++;
        continue;
      }
      if (planned.work === "known-broken") {
        pageCounts.broken++;
        continue;
      }

      extractions++;
      const read = await readMetadata(storage, planned.object, pageCounts);
      if (!read.read) {
        // Only bytes that will read the same way for ever are worth
        // remembering; a bucket that failed says nothing about them.
        if (read.itsOwnFault) {
          memo.set(planned.object.key, planned.object.etag);
          memoChanged = true;
        }
        continue;
      }

      extracted.push({
        rows: deriveRows(planned.object, read.metadata, now, library.id),
        cover: read.metadata.cover,
        held: planned.held,
        etag: planned.object.etag,
        changed: bytesChanged(planned.held, planned.object),
      });
    }

    // Before anything is written: the albums' covers, and whether another
    // library's row already holds one of these track ids (the collision
    // guard, ADR-0009), in one round trip.
    const coverAlbums = [
      ...new Set(
        extracted.filter((item) => item.cover !== undefined).map((item) => item.rows.album.id),
      ),
    ];
    const askAbout = extracted
      .filter(
        (item) => library.id !== DEFAULT_LIBRARY_ID || COLLISION_SHAPED.test(item.rows.track.r2Key),
      )
      .map((item) => item.rows.track.id);
    const pageRows =
      coverAlbums.length + askAbout.length === 0
        ? { covers: new Map<string, string | null>(), foreignTrackIds: new Set<string>() }
        : await findPageRows(db, coverAlbums, askAbout, library.id);

    const written: Extracted[] = [];
    const staleAlbums = new Set<string>();
    for (const item of extracted) {
      if (pageRows.foreignTrackIds.has(item.rows.track.id)) {
        // The upsert would be refused, and the lyrics, cover and album
        // written under another library's id: the object is left out, and
        // remembered at its etag, so it is not read again every pass.
        pageCounts.broken++;
        memo.set(item.rows.track.r2Key, item.etag);
        memoChanged = true;
        console.warn(
          `scan: ${item.rows.track.r2Key} in library ${library.id} hashes to the id of ` +
            "another library's track; skipping it",
        );
        continue;
      }

      written.push(item);
      if (memo.delete(item.rows.track.r2Key)) {
        memoChanged = true;
      }
      pageCounts.indexed++;
      if (item.held === undefined) {
        pageCounts.added++;
      } else {
        pageCounts.updated++;
        // A retagged file can move to another album, leaving the old one a
        // track lighter than it says it is.
        staleAlbums.add(item.held.albumId);
      }
      staleAlbums.add(item.rows.album.id);
    }

    for (const item of written) {
      writes.push(...upsertStatements(db, item.rows, now));
      const lyrics = lyricsStatement(db, item.rows, item.held?.hasLyrics ?? false);
      if (lyrics !== null) {
        writes.push(lyrics);
      }
    }
    for (const [albumId, coverKey] of await storeCovers(
      covers,
      pageRows.covers,
      written,
      pageCounts,
    )) {
      writes.push(setAlbumCoverStatement(db, albumId, coverKey, now));
    }

    let listedToTheEnd = false;
    if (interrupted) {
      skip = position;
    } else {
      // The page is complete, so the stretch of the key space it covers can
      // be swept of the tracks the bucket no longer holds, and the memo of
      // broken objects can forget the ones that are no longer there either.
      writes.push(
        ...deleteTracksStatements(
          db,
          missing.map((row) => row.id),
        ),
      );
      pageCounts.removed += missing.length;
      for (const row of missing) {
        staleAlbums.add(row.albumId);
      }
      for (const key of [...memo.keys()]) {
        if (key > sweptTo && (through === null || key <= through) && !listedKeys.has(key)) {
          memo.delete(key);
          memoChanged = true;
        }
      }

      skip = 0;
      if (listing.cursor !== null) {
        cursor = listing.cursor;
        sweptTo = lastKey ?? sweptTo;
      } else {
        listedToTheEnd = true;
      }
    }

    // After the page's inserts and deletions, because a batch runs in order.
    for (const id of staleAlbums) {
      writes.push(recomputeAlbumStatement(db, id, now));
    }
    if (memoChanged) {
      writes.push(writeBrokenObjectsStatement(db, library.id, memo));
    }
    addPage(library.id, pageCounts);
    if (listedToTheEnd) {
      // The library was listed to its end: stamped, its error cleared, and
      // the pass moves to the next library in the same batch.
      stamp(stamps, library.id, { lastScanAt: now, lastScanError: null });
      moveOn(stamps);
    }

    // One transaction: the page's rows, the deletions that go with them, and
    // the cursor that says they are done. A run killed anywhere else redoes
    // this page and nothing more.
    await commit(writes, stamps, pageCounts.indexed + pageCounts.removed > 0);

    if (interrupted) {
      break;
    }
  }

  // Phase 3: every active library has been listed or skipped. Artists are
  // shared, so the prune runs once, for the whole pass.
  if (!paused && current === null) {
    const pruned = noCounts();
    for (const albumLibrary of await prune(covers, db, pruned, ledger)) {
      countsOf(libraryTotals, albumLibrary).albumsRemoved++;
    }
    counts.albumsRemoved += pruned.albumsRemoved;
    counts.artistsRemoved += pruned.artistsRemoved;
    const totals = addedCounts(before, counts);
    // Every row the progress row carried and the ledger holds, the prunes'
    // included, goes on the tally with the summary. This batch's own rows
    // stay in the ledger, for the driver to carry into the import.
    const carried = untallied + ledger.rows;
    ledger.rows = 0;
    untallied = 0;
    ledger.rows += await countedBatch(db, [
      writeLastScanSummaryStatement(db, {
        startedAt,
        finishedAt: now.getTime(),
        counts: totals,
        libraries: libraryTotals,
      }),
      clearScanProgressStatement(db),
      ...(carried > 0 ? [tallyStatement(db, day, carried)] : []),
    ]);

    return ran(true, false);
  }

  if (paused) {
    // The driver ends the pass: nothing after this would carry the rows.
    await flushLedger(db, day, ledger);
  }

  return ran(false, paused);
}

/**
 * Skips the library a pass is in after its listing kept failing
 * (`LibraryListingError`, `maxFailures` times): one batch writes its
 * `last_scan_error` and moves the pass to the next library, so no later
 * library and no playlist waits on it. Its tracks stay. A pass that has
 * already left the library is left alone.
 */
export async function skipLibrary(
  env: Env,
  now: Date,
  libraryId: number,
  reason: StorageFailure,
  options: Pick<ScanOptions, "clock" | "ledger"> = {},
): Promise<void> {
  const db = database(env);
  const day = utcDay((options.clock ?? Date.now)());
  const ledger = options.ledger ?? { rows: 0 };
  const state = await readScanState(db);
  const active = state.libraries.filter((row) => row.state === "active");
  const previous = state.progress;
  const current = firstActiveFrom(active, previous?.libraryId ?? DEFAULT_LIBRARY_ID);
  if (current === null || current.id !== libraryId) {
    return;
  }

  const next = firstActiveFrom(active, libraryId + 1);
  const writes: ScanStatement[] = [stampLibraryStatement(db, libraryId, { lastScanError: reason })];
  if (next !== null) {
    writes.push(stampLibraryStatement(db, next.id, { lastScanStartedAt: now }));
  }
  console.warn(`scan: skipping library ${libraryId} for this pass (${reason})`);
  // What the progress row carried and the ledger holds goes on the tally;
  // this batch's own rows go to the ledger, for the next step.
  const carried = rowsWrittenOn(previous?.untallied ?? null, day) + ledger.rows;
  ledger.rows = 0;
  ledger.rows += await countedBatch(db, [
    ...writes,
    writeScanProgressStatement(db, {
      startedAt: previous?.startedAt ?? now.getTime(),
      libraryId: next?.id ?? libraryId + 1,
      cursor: "",
      skip: 0,
      sweptTo: "",
      restarted: false,
      counts: previous?.counts ?? noCounts(),
      libraries: previous?.libraries ?? {},
      untallied: null,
    }),
    ...(carried > 0 ? [tallyStatement(db, day, carried)] : []),
  ]);
}

/** The first active library whose id is at least `id`, or null when none is. */
function firstActiveFrom(active: readonly ScanLibrary[], id: number): ScanLibrary | null {
  return active.find((row) => row.id >= id) ?? null;
}

/** The stamps one batch writes, merged into one statement a library. */
type Stamps = Map<number, LibraryStamp>;

/** Adds `fields` to the stamp `libraryId` gets in this batch. */
function stamp(stamps: Stamps, libraryId: number, fields: LibraryStamp): void {
  stamps.set(libraryId, { ...stamps.get(libraryId), ...fields });
}

/** A library's counts in `libraries`, created at zero when it has none yet. */
function countsOf(libraries: Record<string, ScanCounts>, libraryId: number): ScanCounts {
  const found = libraries[String(libraryId)];
  if (found !== undefined) {
    return found;
  }
  const created = noCounts();
  libraries[String(libraryId)] = created;

  return created;
}

/** Per-library counts, copied so the step can add to them. */
function copied(libraries: LibraryCounts): Record<string, ScanCounts> {
  const copy: Record<string, ScanCounts> = {};
  for (const [id, counts] of Object.entries(libraries)) {
    copy[id] = addedCounts(noCounts(), counts);
  }

  return copy;
}

/** What this object needs, before any of it is done. */
function planFor(
  object: StoredObject,
  held: Map<string, StoredTrack>,
  broken: BrokenObjects,
  libraryId: number,
): Plan {
  if (!isTrackObject(object, libraryId)) {
    return { work: "ignore" };
  }

  const listed = asLibraryObject(object);
  const row = held.get(listed.key);
  if (
    row !== undefined &&
    row.etag === listed.etag &&
    row.size === listed.size &&
    row.scanVersion >= SCAN_VERSION
  ) {
    return { work: "unchanged" };
  }

  if (broken.get(listed.key) === listed.etag) {
    return { work: "known-broken" };
  }

  return { work: "read", object: listed, held: row };
}

/**
 * Whether the library held this track with other bytes than the object now
 * has - which is what lets a re-read replace its album's cover. A track read
 * again only because its row predates `SCAN_VERSION` has the same bytes, so
 * that re-read writes no cover.
 */
function bytesChanged(held: StoredTrack | undefined, object: LibraryObject): boolean {
  return held !== undefined && (held.etag !== object.etag || held.size !== object.size);
}

/** What came of trying to read an object, and whose fault it was. */
type MetadataRead =
  | { readonly read: true; readonly metadata: TrackMetadata }
  /** `itsOwnFault`: the bytes are wrong, not the bucket, so remember it. */
  | { readonly read: false; readonly itsOwnFault: boolean };

/**
 * Reads one object's metadata, or counts why it could not be read.
 *
 * The two failures are not the same news (`library/metadata.ts`): bytes that
 * are not what they claim will read the same way for ever and are worth
 * remembering, while a bucket that failed may well answer next time, so that
 * object is left unindexed *and* unremembered and the next run reads it
 * again. A key the storage cannot name in a request (a `.` or `..` segment,
 * over the S3 API) is the first kind: it is refused before any request is
 * made, and will be refused for ever, so it is broken.
 */
async function readMetadata(
  storage: LibraryStorage,
  object: LibraryObject,
  counts: ScanCounts,
): Promise<MetadataRead> {
  try {
    const metadata = await extractMetadata(
      storageSource(storage, object.key, object.size),
      suffixOf(object.key),
    );

    return { read: true, metadata };
  } catch (error) {
    if (error instanceof MetadataError && error.code === "source-failed") {
      if (causedBy(error, UnaddressableKeyError)) {
        counts.broken++;
        console.warn(`scan: ${object.key} cannot be requested from its bucket; skipping`);

        return { read: false, itsOwnFault: true };
      }

      counts.deferred++;
      console.warn(`scan: could not read ${object.key}; retrying next run`, error);

      return { read: false, itsOwnFault: false };
    }

    counts.broken++;
    console.warn(`scan: ${object.key} is not readable audio; skipping`, error);

    return { read: false, itsOwnFault: true };
  }
}

/** Whether `error`, or anything in its chain of causes, is a `kind`. */
function causedBy(error: unknown, kind: abstract new (...args: never[]) => Error): boolean {
  let at: unknown = error;
  for (let depth = 0; depth < 8 && typeof at === "object" && at !== null; depth++) {
    if (at instanceof kind) {
      return true;
    }
    at = (at as { cause?: unknown }).cause;
  }

  return false;
}

/**
 * Writes the covers this page's tracks earned their albums, and says which
 * album now points where. `held` is the cover each album already has
 * (`findPageRows`). Every cover goes to the bound bucket, whatever library
 * its track is in (#84, "Covers").
 *
 * An album's artwork is written **once**: the first track of a new album that
 * carries a picture gives the album its cover, and the album's other tracks
 * leave it alone (#14). The one thing that replaces it is that same file
 * coming back with different bytes - a retagged track whose artwork may have
 * changed with everything else - so a rescan of an unchanged bucket writes no
 * object at all, and re-tagging a file is not a dead end.
 *
 * This is a deliberate simplification of Navidrome, which picks an album's art
 * from the track with the lowest disc number and then the lowest path
 * (`model/mediafile.go`, `firstArtPath`). That rule needs every track of the
 * album in hand at once, which a pass spread over runs does not have, and it
 * would rewrite the object whenever a lower-sorting track appeared.
 *
 * The `put`s are sequential on purpose. A Worker may have only six
 * connections waiting for response headers at a time
 * (developers.cloudflare.com/workers/platform/limits, "Simultaneous open
 * connections"), and the run's budget caps the number of covers at six
 * anyway, so concurrency would buy latency the cron does not care about.
 */
async function storeCovers(
  covers: LibraryStorage,
  held: ReadonlyMap<string, string | null>,
  extracted: readonly Extracted[],
  counts: ScanCounts,
): Promise<Map<string, string>> {
  const written = new Map<string, string>();

  for (const item of extracted) {
    const cover = item.cover;
    if (cover === undefined) {
      continue;
    }

    const albumId = item.rows.album.id;
    if (written.has(albumId)) {
      continue;
    }

    const current = held.get(albumId) ?? null;
    if (current !== null && !item.changed) {
      continue;
    }

    const key = coverKeyFor(albumId, cover);
    if (key === null) {
      continue;
    }

    await covers.put(key, cover.bytes, { contentType: cover.mimeType });
    counts.coversWritten++;
    written.set(albumId, key);

    // A picture in a new format is stored under a new name, so the old object
    // would otherwise sit in the bucket with nothing pointing at it.
    if (current !== null && current !== key) {
      await covers.delete([current]);
    }
  }

  return written;
}

/**
 * The end of a pass: albums no track belongs to and artists no album belongs
 * to are removed, together with the cover objects those albums owned (in the
 * bound bucket), and the playlist entries the sweep left pointing at nothing.
 * It answers the library of each album it removed.
 */
async function prune(
  covers: LibraryStorage,
  db: Database,
  counts: ScanCounts,
  ledger: RowLedger,
): Promise<number[]> {
  const albums = await pruneEmptyAlbums(db);
  ledger.rows += albums.rowsWritten;
  counts.albumsRemoved += albums.removed.length;

  const orphanedCovers = albums.removed
    .map((row) => row.coverKey)
    .filter((key): key is string => key !== null);
  // One bulk delete a thousand keys, none for none.
  await covers.delete(orphanedCovers);

  const artists = await pruneEmptyArtists(db);
  ledger.rows += artists.rowsWritten;
  counts.artistsRemoved += artists.removed.length;

  ledger.rows += await pruneOrphanPlaylistEntries(db);

  return albums.removed.map((row) => row.libraryId);
}

/**
 * Whether the scan should treat this object as a track. In library 1,
 * `_covers/` holds what the scan itself writes; in any other library it is a
 * folder like any other (#84, "Covers"). Everything else is decided by the
 * one suffix allowlist that also gives a track its content type - so `.m3u`
 * playlists, artwork and stray files are never mistaken for music.
 */
function isTrackObject(object: StoredObject, libraryId: number): boolean {
  return (libraryId !== DEFAULT_LIBRARY_ID || !isCoverKey(object.key)) && isAudioKey(object.key);
}

function asLibraryObject(object: StoredObject): LibraryObject {
  return {
    key: object.key,
    size: object.size,
    etag: object.etag,
    uploaded: object.uploaded,
  };
}

function keyOf(object: StoredObject): string {
  return object.key;
}
