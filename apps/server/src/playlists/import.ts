/**
 * The playlist import: the scheduled pass that turns the `.m3u` files in the
 * bucket into Playlists.
 *
 * It runs from the same cron entry as the Scan and **after** it (#17), because
 * an entry can only resolve to a Track the scan has already indexed.
 *
 * ## Why every file is read on every pass
 *
 * A pass re-reads and re-imports every `.m3u` it finds rather than skipping
 * the ones whose object has not changed. That is Navidrome's rule, and its
 * reason is written in `core/playlists/import.go`: "Only smart playlists skip
 * on an unchanged file; M3U must re-run so newly-added tracks resolve."
 *
 * It matters more here than there. Our scan is spread over many cron runs, so
 * the first import of a playlist happens while most of the library is still
 * unindexed: a line that finds no Track today finds one in an hour. Skipping
 * an unchanged file would freeze that half-resolved playlist for ever - and
 * the same applies after the scan's sweep removes a track and takes the
 * entries pointing at it with it, which would otherwise leave the playlist's
 * song count and positions wrong until somebody edited the file.
 *
 * Re-importing is cheap because an `.m3u` is small and there are few of them,
 * and because a pass that resolves to what the library already holds writes
 * nothing: the stored row and its entries are read back and compared first
 * (`matchesStoredPlaylist`), so a pass over an unchanged bucket is idempotent
 * in cost as well as in content. It has to be. D1's free tier allows 100,000
 * rows written a day, and deleting and re-inserting every entry of every
 * playlist every quarter of an hour spent that many times over on a library
 * of fourteen playlists (#61). What still costs the same is the reading: the
 * file, the tracks its lines name and the rows it would write are read on
 * every pass, and a playlist that differs in anything - a line added, moved
 * or now resolving, a track the scan swept - is rewritten whole.
 *
 * ## Why a run is bounded
 *
 * As with the scan, a free-tier invocation has a subrequest and CPU budget, so
 * a run does a fixed amount of work and stops, leaving a cursor behind
 * (`state.ts`). `importsPerRun` bounds the expensive path - one R2 read, one
 * lookup of the tracks a file names and, only for a playlist that differs,
 * one D1 batch - and `objectsPerRun` bounds the cheap walk past everything in
 * the bucket that is not a playlist. A library with a handful of `.m3u` files
 * finishes a pass in a single run; five hundred of them would take
 * twenty-five, which at the default schedule is a few hours for the first
 * pass and nothing at all afterwards, since a run that changes nothing now
 * writes nothing.
 *
 * The progress row is written after **every page**, so an invocation that is
 * killed half way through costs at most the page it was in rather than
 * restarting the pass - which, for a pass longer than the interval between
 * runs, would mean it never finished.
 */

import { DEFAULT_LIBRARY_ID, playlistId } from "@stratosonic/db";
import { type Database, database } from "../db";
import type { Env } from "../env";
import {
  budgetReached,
  countedBatch,
  dailyWriteBudget,
  flushLedger,
  type RowLedger,
  rowsWrittenOn,
  tallyStatement,
  utcDay,
} from "../scanner/budget";
import { isCoverKey } from "../scanner/covers";
import { LibraryListingError, listingFailure, skipsAtOnce } from "../scanner/listing-failure";
import { stampLibraryStatement } from "../scanner/repository";
import { bindingStorage } from "../storage/binding";
import type {
  LibraryStorage,
  StorageFailure,
  StorageListing,
  StoredObject,
} from "../storage/storage";
import { findFirstAdmin } from "../users/repository";
import { entryKeyCandidates, isPlaylistKey, parseM3u, playlistNameFromKey } from "./m3u";
import {
  type EntryTrack,
  findPlaylistsByKeys,
  findTracksByKeys,
  type ImportedPlaylist,
  type IndexedPlaylist,
  matchesStoredPlaylist,
  sweepMissingPlaylists,
  upsertPlaylistStatements,
} from "./repository";
import {
  addPlaylistImportCounts,
  clearPlaylistImportProgressStatement,
  noPlaylistImportCounts,
  type PlaylistImportCounts,
  type PlaylistImportProgress,
  readPlaylistImportState,
  writePlaylistImportProgressStatement,
} from "./state";

/** How much of the bucket one run gets through. See the notes above. */
export interface PlaylistImportLimits {
  /** Objects per `list()`, and therefore per sweep. */
  readonly pageSize: number;
  /** Playlists this run may read and write. */
  readonly importsPerRun: number;
  /** Objects this run may look at at all, playlist or not. */
  readonly objectsPerRun: number;
}

export const DEFAULT_PLAYLIST_IMPORT_LIMITS: PlaylistImportLimits = {
  pageSize: 500,
  importsPerRun: 20,
  objectsPerRun: 5000,
};

/**
 * Whether a newly discovered playlist is visible to everyone.
 *
 * Navidrome's default is the opposite (`defaultplaylistpublicvisibility` is
 * false in conf/configuration.go), but its playlists belong to whichever of
 * many users imported them. Stratosonic serves one person, who owns every
 * `.m3u` in the bucket, and #17 asks for `public` true so nothing is hidden
 * from a second account added later. An existing row keeps whatever it has.
 *
 * `createPlaylist` uses the same value, so a playlist a client made and the
 * same playlist imported from its file on a rebuilt database are one row and
 * not two spellings of one.
 */
export const DEFAULT_PUBLIC = true;

/** What a run is given beyond its stamp and limits, as the scan is (`ScanOptions`). */
export interface PlaylistImportOptions {
  /** The day's D1 write budget, `0` for no cap; `SCAN_DAILY_WRITE_BUDGET` when absent. */
  readonly writeBudget?: number;
  /** The wall clock, which says what UTC day the budget is counted in. */
  readonly clock?: () => number;
  /**
   * The rows written that neither the tally nor a progress row holds yet,
   * as the scan's (`ScanOptions.ledger`): the run adds its own batches'
   * rows, and leaves its last batch's for the driver to carry.
   */
  readonly ledger?: RowLedger;
}

/** What one run of the import did. */
export interface PlaylistImportRun {
  /** Whether the pass finished: the listing ran out and the sweep ran, or the library was skipped. */
  readonly completed: boolean;
  /** Whether the run stopped at the daily write budget (`scanner/budget.ts`). */
  readonly paused: boolean;
  /** Epoch milliseconds the pass - not this run - began at. */
  readonly startedAt: number;
  /** What this run alone did. */
  readonly counts: PlaylistImportCounts;
  /** What the whole pass has done, this run included. */
  readonly totals: PlaylistImportCounts;
}

/**
 * Runs one bounded step of the playlist import and reports what it did.
 *
 * `now` is the instant the run is stamped with - the cron's scheduled time in
 * production, a fixed value in a test. Almost nothing is stamped with it: a
 * playlist's `created` and `changed` come from its object, so a pass is a
 * function of the bucket rather than of when it ran.
 *
 * Nothing here is fatal. An object R2 cannot produce is counted as deferred
 * and left for the next run; an entry that names no track is counted and
 * skipped, because one bad line must not cost the whole playlist (#17).
 *
 * A failed listing judges the library as the scan's does (#84, "Skipping a
 * library", `scanner/listing-failure.ts`): refused credentials or a missing
 * bucket skip it at once, a refused cursor restarts the listing once, and
 * anything else is a `LibraryListingError` the driver retries, then skips
 * (`skipPlaylistLibrary`). The import reads library 1, the bound bucket; the
 * import from every library is #84's ticket F.
 *
 * Every row it writes counts against the daily write budget, as D1 reports
 * it: the progress rows, and each playlist's row and entries. A run that
 * finds the budget spent stops before its next page and answers `paused`.
 */
export async function importPlaylists(
  env: Env,
  now: Date = new Date(),
  limits: PlaylistImportLimits = DEFAULT_PLAYLIST_IMPORT_LIMITS,
  options: PlaylistImportOptions = {},
): Promise<PlaylistImportRun> {
  const db = database(env);
  const libraryId = DEFAULT_LIBRARY_ID;
  const storage = bindingStorage(env);
  const budget = options.writeBudget ?? dailyWriteBudget(env);
  const day = utcDay((options.clock ?? Date.now)());
  const { progress: previous, rowsWritten } = await readPlaylistImportState(db);
  // Today's rows the tally does not hold yet: carried in the progress row
  // (`untallied`), and in the ledger.
  let untallied = rowsWrittenOn(previous?.untallied ?? null, day);
  const ledger = options.ledger ?? { rows: 0 };
  let spent = rowsWrittenOn(rowsWritten, day) + untallied + ledger.rows;
  const startedAt = previous?.startedAt ?? now.getTime();
  const before = previous?.counts ?? noPlaylistImportCounts();
  const counts = noPlaylistImportCounts();
  counts.steps = 1;
  const ran = (completed: boolean, paused = false): PlaylistImportRun => ({
    completed,
    paused,
    startedAt,
    counts,
    totals: totalsOf(before, counts),
  });

  if (budgetReached(spent, budget)) {
    console.warn(`playlists: paused until tomorrow, ${spent} of ${budget} rows written today`);
    await flushLedger(db, day, ledger);

    return ran(false, true);
  }

  const owner = await findFirstAdmin(db);
  if (owner === null) {
    // Navidrome defers the import in the same situation (its playlist phase
    // records a pending flag when there is no admin yet). Here the bootstrap
    // has already run by the time the cron reaches this, so this is a guard
    // rather than a state anything should reach.
    console.warn("playlists: no admin user yet; nothing imported");

    return ran(false);
  }

  let cursor = previous?.cursor ?? "";
  let skip = previous?.skip ?? 0;
  let sweptTo = previous?.sweptTo ?? "";
  let restarted = previous?.restarted ?? false;
  let imports = 0;
  let completed = false;

  const progress = (carrying: number = untallied): PlaylistImportProgress => ({
    startedAt,
    cursor,
    skip,
    sweptTo,
    restarted,
    counts: totalsOf(before, counts),
    untallied: carrying === 0 ? null : { day, rows: carrying },
  });

  /**
   * Writes the progress row, which carries the rows written so far for the
   * day's tally (`untallied`), or, at the end of the pass, clears it and
   * puts every row it carried on the tally, then the end's own
   * (`flushLedger`), as nothing comes after it (`scanner/budget.ts`).
   */
  const commit = async (done: boolean): Promise<void> => {
    // Nothing is moved until the batch has run: one D1 refuses changes
    // nothing, the carry included.
    const carried = untallied + ledger.rows;
    if (done) {
      const rows = await countedBatch(db, [
        clearPlaylistImportProgressStatement(db),
        ...(carried > 0 ? [tallyStatement(db, day, carried)] : []),
      ]);
      untallied = 0;
      ledger.rows = rows;
      spent += rows;
      await flushLedger(db, day, ledger);
      return;
    }
    const rows = await countedBatch(db, [
      writePlaylistImportProgressStatement(db, progress(carried)),
    ]);
    untallied = carried;
    ledger.rows = rows;
    spent += rows;
  };

  for (;;) {
    if (budgetReached(spent, budget)) {
      // Every page so far is committed with its progress: the next UTC day
      // resumes from here.
      console.warn(`playlists: paused until tomorrow, ${spent} of ${budget} rows written today`);
      await flushLedger(db, day, ledger);

      return ran(false, true);
    }

    let listing: StorageListing;
    try {
      listing = await storage.list({
        limit: limits.pageSize,
        ...(cursor === "" ? {} : { cursor }),
      });
    } catch (error) {
      const reason = listingFailure(error);
      if (skipsAtOnce(reason)) {
        console.warn(`playlists: skipping library ${libraryId} for this pass (${reason})`, error);
        const carried = untallied + ledger.rows;
        ledger.rows = await countedBatch(db, [
          stampLibraryStatement(db, libraryId, { lastScanError: reason }),
          clearPlaylistImportProgressStatement(db),
          ...(carried > 0 ? [tallyStatement(db, day, carried)] : []),
        ]);
        untallied = 0;
        await flushLedger(db, day, ledger);

        return ran(true);
      }
      if (reason === "invalid_cursor" && cursor !== "" && !restarted) {
        console.warn(`playlists: library ${libraryId} refused its cursor; listing it again`);
        cursor = "";
        skip = 0;
        sweptTo = "";
        restarted = true;
        await commit(false);
        continue;
      }
      throw new LibraryListingError(
        libraryId,
        reason === "invalid_cursor" ? "unavailable" : reason,
        { cause: error },
      );
    }
    const objects = listing.objects;
    // Every playlist the page offered, which is what the sweep is allowed to
    // measure the library against - and, separately, the ones this run will
    // actually get to. The stored rows and entries are read only for those:
    // a page holds up to five hundred objects and a run imports twenty, so
    // reading the page's worth would be twenty-five runs each reading every
    // playlist's entries, which on a big library is millions of rows read a
    // day against D1's five million (#61).
    const pageKeys = objects.filter(isPlaylistObject).map((object) => object.key);
    const stored = await findPlaylistsByKeys(
      db,
      objects
        .slice(skip)
        .filter(isPlaylistObject)
        .slice(0, limits.importsPerRun - imports)
        .map((object) => object.key),
    );

    let position = skip;
    let interrupted = false;

    for (; position < objects.length; position++) {
      const object = objects[position];
      if (object === undefined) {
        continue;
      }

      if (counts.examined >= limits.objectsPerRun) {
        interrupted = true;
        break;
      }

      if (!isPlaylistObject(object)) {
        counts.examined++;
        continue;
      }

      if (imports >= limits.importsPerRun) {
        interrupted = true;
        break;
      }

      counts.examined++;
      imports++;

      ledger.rows += await importOne(storage, db, object, owner.id, stored.get(object.key), counts);
    }

    if (interrupted) {
      skip = position;
      break;
    }

    // The page is complete, so the stretch of the key space it covers can be
    // swept of playlists whose `.m3u` the bucket no longer holds. A listing
    // that failed would have thrown above, so an empty page here means the
    // bucket really has nothing in that stretch.
    const lastKey = objects.at(-1)?.key;
    const removed = await sweepMissingPlaylists(
      db,
      sweptTo,
      listing.cursor !== null ? (lastKey ?? sweptTo) : null,
      pageKeys,
      new Date(startedAt),
      ledger,
    );
    counts.removed += removed.length;

    skip = 0;
    if (listing.cursor === null) {
      completed = true;
      break;
    }

    cursor = listing.cursor;
    if (lastKey !== undefined) {
      sweptTo = lastKey;
    }

    // Written per page, not per run: a run the platform cuts short must not
    // cost more than the page it was in.
    await commit(false);
  }

  await commit(completed);

  return ran(completed);
}

/**
 * Skips the import of a library whose listing kept failing
 * (`LibraryListingError`, `maxFailures` times): one batch writes its
 * `last_scan_error` and ends the import's pass, so the pass ends rather than
 * being given up. Its playlists stay.
 */
export async function skipPlaylistLibrary(
  env: Env,
  libraryId: number,
  reason: StorageFailure,
  options: Pick<PlaylistImportOptions, "clock" | "ledger"> = {},
): Promise<void> {
  const db = database(env);
  const day = utcDay((options.clock ?? Date.now)());
  const ledger = options.ledger ?? { rows: 0 };
  const { progress } = await readPlaylistImportState(db);
  console.warn(`playlists: skipping library ${libraryId} for this pass (${reason})`);
  // The pass ends here: what the progress row carried and the ledger holds
  // go on the tally, and then this batch's own rows.
  const carried = rowsWrittenOn(progress?.untallied ?? null, day) + ledger.rows;
  ledger.rows = await countedBatch(db, [
    stampLibraryStatement(db, libraryId, { lastScanError: reason }),
    clearPlaylistImportProgressStatement(db),
    ...(carried > 0 ? [tallyStatement(db, day, carried)] : []),
  ]);
  await flushLedger(db, day, ledger);
}

/**
 * Reads one `.m3u` and makes the library agree with it.
 *
 * The entries are resolved in one lookup for the whole file rather than one
 * per line: a playlist of two hundred songs is then two D1 reads, not two
 * hundred. It answers the rows D1 says it wrote: none for a playlist the
 * library already holds exactly.
 */
async function importOne(
  storage: LibraryStorage,
  db: Database,
  object: StoredObject,
  adminId: string,
  held: IndexedPlaylist | undefined,
  counts: PlaylistImportCounts,
): Promise<number> {
  const text = await readPlaylistText(storage, object.key, counts);
  if (text === null) {
    return 0;
  }

  const parsed = parseM3u(text);
  const candidates = parsed.entries.map((entry) => entryKeyCandidates(object.key, entry));
  const tracks = await findTracksByKeys(db, [...new Set(candidates.flat())]);

  const matched: EntryTrack[] = [];
  for (const [index, keys] of candidates.entries()) {
    const found = keys.map((key) => tracks.get(key)).find((entry) => entry !== undefined);
    if (found === undefined) {
      counts.unmatched++;
      console.warn(`playlists: ${object.key} lists a path with no track: ${parsed.entries[index]}`);
      continue;
    }

    matched.push(found);
  }

  const imported: ImportedPlaylist = {
    // Playlists are read from the bound bucket until the import walks
    // every library (#84, ticket F).
    id: playlistId(DEFAULT_LIBRARY_ID, object.key),
    name: parsed.name ?? playlistNameFromKey(object.key),
    // Navidrome stamps an auto-imported playlist with where it came from
    // (`newSyncedPlaylist`), and keeps whatever the row already says on a
    // re-import, so a comment edited later survives.
    comment: held?.comment ?? autoImportedComment(object.key),
    ownerId: held?.ownerId ?? adminId,
    public: held?.public ?? DEFAULT_PUBLIC,
    songCount: matched.length,
    duration: matched.reduce((total, entry) => total + entry.duration, 0),
    r2Key: object.key,
    libraryId: DEFAULT_LIBRARY_ID,
    // `created` is when the playlist first appeared and does not move again;
    // `changed` is the object's upload time, which is Navidrome's
    // `UpdatedAt: info.ModTime()` - the file's own clock rather than ours, so
    // a re-import of an untouched file changes nothing a client can see.
    createdAt: held?.createdAt ?? object.uploaded,
    changedAt: object.uploaded,
    trackIds: matched.map((entry) => entry.id),
  };

  counts.imported++;
  counts.entries += matched.length;

  // The resolving is done either way - that is what makes the import correct
  // - but the writing is skipped when the library already holds this exact
  // result, which is the ordinary case on every pass after the first.
  if (matchesStoredPlaylist(held, imported)) {
    counts.unchanged++;

    return 0;
  }

  return countedBatch(db, upsertPlaylistStatements(db, imported));
}

/**
 * The text of one playlist object, or null when R2 could not produce it -
 * which is counted as deferred and retried by the next run, exactly as the
 * scan defers an object it could not read.
 */
async function readPlaylistText(
  storage: LibraryStorage,
  key: string,
  counts: PlaylistImportCounts,
): Promise<string | null> {
  try {
    const object = await storage.get(key);
    if (object === null) {
      // Deleted between the listing and now. The next pass will not list it,
      // and the sweep will remove whatever it left behind.
      counts.deferred++;

      return null;
    }

    return new TextDecoder().decode(await object.bytes());
  } catch (error) {
    counts.deferred++;
    console.warn(`playlists: could not read ${key}; retrying next run`, error);

    return null;
  }
}

/** Navidrome's comment for a playlist it imported from a file. */
function autoImportedComment(r2Key: string): string {
  return `Auto-imported from '${r2Key.slice(r2Key.lastIndexOf("/") + 1)}'`;
}

/**
 * Whether the import should read this object. `_covers/` holds what the scan
 * writes, and everything else is decided by the playlist suffixes - so audio,
 * artwork and stray files are never mistaken for a playlist.
 */
function isPlaylistObject(object: StoredObject): boolean {
  return !isCoverKey(object.key) && isPlaylistKey(object.key);
}

function totalsOf(
  before: PlaylistImportCounts,
  counts: PlaylistImportCounts,
): PlaylistImportCounts {
  const totals = noPlaylistImportCounts();
  addPlaylistImportCounts(totals, before);
  addPlaylistImportCounts(totals, counts);

  return totals;
}
