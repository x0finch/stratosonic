/**
 * The playlist import: the scheduled pass that turns the `.m3u` files in
 * every library's bucket into Playlists.
 *
 * It runs from the same cron entry as the Scan and **after** it (#17), because
 * an entry can only resolve to a Track the scan has already indexed.
 *
 * ## Every library (#84, "Playlists across libraries")
 *
 * A pass reads the playlists of every `active` library, in ascending id from
 * its own cursor, as the scan walks them and as Navidrome imports from every
 * library's folders. A playlist's row carries its file's library, its id is
 * `playlistId(libraryId, key)`, and its owner is still `findFirstAdmin`.
 * A bare entry resolves in the playlist's own library; one that starts with
 * a library's path names that library (`entryCandidates`, playlists/m3u.ts).
 *
 * A failed listing judges the library as the scan's does (#84, "Skipping a
 * library", `scanner/listing-failure.ts`): refused credentials or a missing
 * bucket skip it at once, with `last_scan_error`, and the pass moves to the
 * next library; a refused cursor restarts its listing once; anything else is
 * a `LibraryListingError` the driver retries, then skips
 * (`skipPlaylistLibrary`). A skipped library keeps its playlists: nothing is
 * swept from a library that was not listed.
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
 * (`state.ts`). `importsPerRun` bounds the expensive path - one storage read,
 * one lookup of the tracks a file names and, only for a playlist that
 * differs, one D1 batch - and `objectsPerRun` bounds the cheap walk past
 * everything in the bucket that is not a playlist. `subrequestsPerRun` bounds
 * them together, as the scan's budget reads it: every D1 round trip and every
 * storage call counts, binding or S3 alike (#84, "The step budget,
 * recomputed for S3"), and a run stops before a page or a playlist that might
 * not fit in what is left. A library with a handful of `.m3u` files finishes a
 * pass in a single run; five hundred of them would take thirty or so, which
 * at the default schedule is a few hours for the first pass and nothing at
 * all afterwards, since a run that changes nothing writes nothing.
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
import { type ScanStatement, stampLibraryStatement } from "../scanner/repository";
import { COLLISION_SHAPED } from "../scanner/scan";
import type { ScanLibrary } from "../scanner/state";
import { storageFor } from "../storage/for-library";
import type {
  LibraryStorage,
  StorageFailure,
  StorageListing,
  StoredObject,
} from "../storage/storage";
import { findFirstAdmin } from "../users/repository";
import {
  type EntryCandidates,
  entryCandidates,
  isPlaylistKey,
  type PlaylistLibrary,
  parseM3u,
  playlistNameFromKey,
} from "./m3u";
import {
  type EntryTrack,
  findPlaylistsByKeys,
  findTracksByKeys,
  type ImportedPlaylist,
  type LibraryKeys,
  matchesStoredPlaylist,
  type PlaylistsByKey,
  type StatementTally,
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
  /**
   * Subrequests this run may make, every D1 round trip and storage call
   * counted, as the scan counts its own 42 of the free plan's 50 (#84).
   */
  readonly subrequestsPerRun: number;
}

export const DEFAULT_PLAYLIST_IMPORT_LIMITS: PlaylistImportLimits = {
  pageSize: 500,
  importsPerRun: 20,
  objectsPerRun: 5000,
  subrequestsPerRun: 42,
};

/**
 * What the rest of a page may still cost once its playlists are imported:
 * the sweep's read, the progress batch (or the end of the pass's) and the
 * tally the end of a run may flush. A sweep that deletes adds a statement
 * per ninety playlists gone, which the headroom to 50 covers.
 */
const PAGE_TAIL_SUBREQUESTS = 3;

/**
 * The most one playlist costs: its read, the lookup of the tracks it names
 * (one statement for up to ninety candidate keys; a longer file adds one per
 * ninety more, as #84's "one statement per file" chunks it), and its batch.
 */
const IMPORT_SUBREQUESTS = 3;

/**
 * What a run makes sure is left before it lists a page: the listing, the
 * lookup of the page's stored playlists and their entries, one playlist, and
 * the page's tail.
 */
const PAGE_SUBREQUESTS = 1 + 2 + IMPORT_SUBREQUESTS + PAGE_TAIL_SUBREQUESTS;

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
  /** Whether the pass finished: every active library was listed to its end, or skipped. */
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
 * function of the buckets rather than of when it ran.
 *
 * Nothing here is fatal. An object storage cannot produce is counted as
 * deferred and left for the next run; an entry that names no track is
 * counted and skipped, because one bad line must not cost the whole playlist
 * (#17); a file whose id another library's playlist holds is counted broken
 * and left out. A failed listing is judged as the notes above say.
 *
 * Every row it writes counts against the daily write budget, as D1 reports
 * it: the progress rows, the library stamps, and each playlist's row and
 * entries. A run that finds the budget spent stops before its next page and
 * answers `paused`.
 */
export async function importPlaylists(
  env: Env,
  now: Date = new Date(),
  limits: PlaylistImportLimits = DEFAULT_PLAYLIST_IMPORT_LIMITS,
  options: PlaylistImportOptions = {},
): Promise<PlaylistImportRun> {
  const db = database(env);
  const budget = options.writeBudget ?? dailyWriteBudget(env);
  const day = utcDay((options.clock ?? Date.now)());
  const state = await readPlaylistImportState(db);
  // Every subrequest the run makes, this first batch included.
  const calls: StatementTally = { statements: 1 };
  const previous = state.progress;
  // Today's rows the tally does not hold yet: carried in the progress row
  // (`untallied`), and in the ledger.
  let untallied = rowsWrittenOn(previous?.untallied ?? null, day);
  const ledger = options.ledger ?? { rows: 0 };
  let spent = rowsWrittenOn(state.rowsWritten, day) + untallied + ledger.rows;
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

  calls.statements++;
  const owner = await findFirstAdmin(db);
  if (owner === null) {
    // Navidrome defers the import in the same situation (its playlist phase
    // records a pending flag when there is no admin yet). Here the bootstrap
    // has already run by the time the cron reaches this, so this is a guard
    // rather than a state anything should reach.
    console.warn("playlists: no admin user yet; nothing imported");

    return ran(false);
  }

  // Every library's path, whatever its state, names it in an entry; only
  // the active ones are walked, and only their tracks resolve.
  const libraries: readonly PlaylistLibrary[] = state.libraries.map((row) => ({
    id: row.id,
    path: row.path,
    active: row.state === "active",
  }));
  const active = state.libraries.filter((row) => row.state === "active");
  const wanted = previous?.libraryId ?? DEFAULT_LIBRARY_ID;
  let current = firstActiveFrom(active, wanted);
  // A library no longer active is left with its cursor: nothing is swept.
  const resumes = previous !== null && current !== null && current.id === previous.libraryId;
  let cursor = resumes ? previous.cursor : "";
  let skip = resumes ? previous.skip : 0;
  let sweptTo = resumes ? previous.sweptTo : "";
  let restarted = resumes ? previous.restarted : false;
  // Where the progress points once every library has been left.
  let past = wanted;
  const storages = new Map<number, LibraryStorage>();
  let imports = 0;
  let completed = false;
  // Whether this run has moved past what the progress row says.
  let uncommitted = false;

  const progress = (carrying: number = untallied): PlaylistImportProgress => ({
    startedAt,
    libraryId: current?.id ?? past,
    cursor,
    skip,
    sweptTo,
    restarted,
    counts: totalsOf(before, counts),
    untallied: carrying === 0 ? null : { day, rows: carrying },
  });

  /** Leaves the library the pass is in for the next active one, from its start. */
  const moveOn = (): void => {
    if (current === null) {
      return;
    }
    past = current.id + 1;
    current = firstActiveFrom(active, past);
    cursor = "";
    skip = 0;
    sweptTo = "";
    restarted = false;
  };

  /**
   * Writes the progress row, with `writes` before it in the same batch,
   * which carries the rows written so far for the day's tally (`untallied`),
   * or, at the end of the pass, clears it and puts every row it carried on
   * the tally, then the end's own (`flushLedger`), as nothing comes after it
   * (`scanner/budget.ts`).
   */
  const commit = async (done: boolean, writes: readonly ScanStatement[] = []): Promise<void> => {
    // Nothing is moved until the batch has run: one D1 refuses changes
    // nothing, the carry included.
    const carried = untallied + ledger.rows;
    calls.statements++;
    if (done) {
      const rows = await countedBatch(db, [
        ...writes,
        clearPlaylistImportProgressStatement(db),
        ...(carried > 0 ? [tallyStatement(db, day, carried)] : []),
      ]);
      untallied = 0;
      ledger.rows = rows;
      spent += rows;
      uncommitted = false;
      if (ledger.rows > 0) {
        calls.statements++;
      }
      await flushLedger(db, day, ledger);
      return;
    }
    const rows = await countedBatch(db, [
      ...writes,
      writePlaylistImportProgressStatement(db, progress(carried)),
    ]);
    untallied = carried;
    ledger.rows = rows;
    spent += rows;
    uncommitted = false;
  };

  for (;;) {
    const library = current;
    if (library === null) {
      completed = true;
      break;
    }

    if (budgetReached(spent, budget)) {
      // Every page so far is committed with its progress: the next UTC day
      // resumes from here.
      console.warn(`playlists: paused until tomorrow, ${spent} of ${budget} rows written today`);
      await flushLedger(db, day, ledger);

      return ran(false, true);
    }

    if (calls.statements + PAGE_SUBREQUESTS > limits.subrequestsPerRun) {
      // The step's subrequests are spent; the next step lists this page.
      break;
    }

    let storage: LibraryStorage;
    let listing: StorageListing;
    try {
      storage = storages.get(library.id) ?? storageFor(env, library);
      storages.set(library.id, storage);
      calls.statements++;
      listing = await storage.list({
        limit: limits.pageSize,
        ...(cursor === "" ? {} : { cursor }),
      });
    } catch (error) {
      const reason = listingFailure(error);
      if (skipsAtOnce(reason)) {
        // The key was refused, or the bucket is gone: the library is
        // skipped for this pass at once, with its playlists kept.
        console.warn(`playlists: skipping library ${library.id} for this pass (${reason})`, error);
        moveOn();
        const stamp = stampLibraryStatement(db, library.id, { lastScanError: reason });
        if (current === null) {
          await commit(true, [stamp]);

          return ran(true);
        }
        await commit(false, [stamp]);
        continue;
      }
      if (reason === "invalid_cursor" && cursor !== "" && !restarted) {
        console.warn(`playlists: library ${library.id} refused its cursor; listing it again`);
        cursor = "";
        skip = 0;
        sweptTo = "";
        restarted = true;
        await commit(false);
        continue;
      }
      throw new LibraryListingError(
        library.id,
        reason === "invalid_cursor" ? "unavailable" : reason,
        { cause: error },
      );
    }
    const objects = listing.objects;
    const isPlaylist = (object: StoredObject) => isPlaylistObject(object, library.id);
    // Every playlist the page offered, which is what the sweep is allowed to
    // measure the library against - and, separately, the ones this run will
    // actually get to. The stored rows and entries are read only for those:
    // a page holds up to five hundred objects and a run imports twenty, so
    // reading the page's worth would be twenty-five runs each reading every
    // playlist's entries, which on a big library is millions of rows read a
    // day against D1's five million (#61).
    const pageKeys = objects.filter(isPlaylist).map((object) => object.key);
    const reachable = objects
      .slice(skip)
      .filter(isPlaylist)
      .slice(0, limits.importsPerRun - imports)
      .map((object) => object.key);
    // The ids another library could already hold (ADR-0009): asked about in
    // the same statement, so a refused upsert is known before anything of
    // it is written.
    const askAbout = reachable
      .filter((key) => library.id !== DEFAULT_LIBRARY_ID || COLLISION_SHAPED.test(key))
      .map((key) => playlistId(library.id, key));
    const stored = await findPlaylistsByKeys(db, library.id, reachable, askAbout, calls);

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

      if (!isPlaylist(object)) {
        counts.examined++;
        continue;
      }

      if (
        imports >= limits.importsPerRun ||
        calls.statements + IMPORT_SUBREQUESTS + PAGE_TAIL_SUBREQUESTS > limits.subrequestsPerRun
      ) {
        interrupted = true;
        break;
      }

      counts.examined++;
      imports++;

      ledger.rows += await importOne(
        { storage, db, library, libraries, adminId: owner.id, calls },
        object,
        stored,
        counts,
      );
    }

    if (interrupted) {
      skip = position;
      uncommitted = true;
      break;
    }

    // The page is complete, so the stretch of the key space it covers can be
    // swept of playlists whose `.m3u` the bucket no longer holds. A listing
    // that failed would have thrown above, so an empty page here means the
    // bucket really has nothing in that stretch.
    const lastKey = objects.at(-1)?.key;
    const removed = await sweepMissingPlaylists(
      db,
      library.id,
      sweptTo,
      listing.cursor !== null ? (lastKey ?? sweptTo) : null,
      pageKeys,
      new Date(startedAt),
      ledger,
      calls,
    );
    counts.removed += removed.length;

    skip = 0;
    if (listing.cursor === null) {
      // The library is listed to its end: the pass moves to the next one, in
      // the batch below, or ends.
      moveOn();
      if (current === null) {
        completed = true;
        break;
      }
    } else {
      cursor = listing.cursor;
      if (lastKey !== undefined) {
        sweptTo = lastKey;
      }
    }

    // Written per page, not per run: a run the platform cuts short must not
    // cost more than the page it was in.
    await commit(false);
  }

  if (completed || uncommitted) {
    await commit(completed);
  }

  return ran(completed);
}

/**
 * Skips the import of a library whose listing kept failing
 * (`LibraryListingError`, `maxFailures` times): one batch writes its
 * `last_scan_error` and moves the import to the next active library, or
 * ends the pass when there is none, so no later library waits on it, and
 * answers whether the pass ended. Its playlists stay. A pass that has
 * already left the library is left alone.
 */
export async function skipPlaylistLibrary(
  env: Env,
  now: Date,
  libraryId: number,
  reason: StorageFailure,
  options: Pick<PlaylistImportOptions, "clock" | "ledger"> = {},
): Promise<{ readonly completed: boolean }> {
  const db = database(env);
  const day = utcDay((options.clock ?? Date.now)());
  const ledger = options.ledger ?? { rows: 0 };
  const { progress, libraries } = await readPlaylistImportState(db);
  const active = libraries.filter((row) => row.state === "active");
  const current = firstActiveFrom(active, progress?.libraryId ?? DEFAULT_LIBRARY_ID);
  if (current === null) {
    return { completed: true };
  }
  if (current.id !== libraryId) {
    return { completed: false };
  }

  console.warn(`playlists: skipping library ${libraryId} for this pass (${reason})`);
  const next = firstActiveFrom(active, libraryId + 1);
  // What the progress row carried and the ledger holds goes on the tally,
  // with this batch.
  const carried = rowsWrittenOn(progress?.untallied ?? null, day) + ledger.rows;
  const writes: ScanStatement[] = [
    stampLibraryStatement(db, libraryId, { lastScanError: reason }),
    next === null
      ? clearPlaylistImportProgressStatement(db)
      : writePlaylistImportProgressStatement(db, {
          startedAt: progress?.startedAt ?? now.getTime(),
          libraryId: next.id,
          cursor: "",
          skip: 0,
          sweptTo: "",
          restarted: false,
          counts: progress?.counts ?? noPlaylistImportCounts(),
          untallied: null,
        }),
    ...(carried > 0 ? [tallyStatement(db, day, carried)] : []),
  ];
  ledger.rows = await countedBatch(db, writes);
  if (next === null) {
    // The pass ends here: this batch's own rows go on the tally too.
    await flushLedger(db, day, ledger);
  }

  return { completed: next === null };
}

/** What importing one file of a library needs beyond the file itself. */
interface ImportContext {
  readonly storage: LibraryStorage;
  readonly db: Database;
  /** The library the file is in. */
  readonly library: Pick<ScanLibrary, "id" | "kind">;
  /** Every library, by which an entry may name another. */
  readonly libraries: readonly PlaylistLibrary[];
  readonly adminId: string;
  /** The run's subrequests, which this adds to. */
  readonly calls: StatementTally;
}

/**
 * Reads one `.m3u` and makes the library agree with it.
 *
 * The entries are resolved in one lookup for the whole file rather than one
 * per line, whatever libraries they name (`findTracksByKeys`): a playlist of
 * two hundred songs is then a few D1 reads, not two hundred. It answers the
 * rows D1 says it wrote: none for a playlist the library already holds
 * exactly, and none for one whose id is another library's, which is broken.
 */
async function importOne(
  context: ImportContext,
  object: StoredObject,
  stored: PlaylistsByKey,
  counts: PlaylistImportCounts,
): Promise<number> {
  const { storage, db, library, libraries, adminId, calls } = context;
  const id = playlistId(library.id, object.key);
  if (stored.foreign.has(id)) {
    // Its upsert would be refused by the collision guard while the entries
    // of the other library's playlist were replaced: nothing of it is
    // written. Only a crafted key reaches this (ADR-0009).
    counts.broken++;
    console.warn(
      `playlists: ${object.key} in library ${library.id} hashes to the id of ` +
        "another library's playlist; skipping it",
    );

    return 0;
  }

  calls.statements++;
  const text = await readPlaylistText(storage, object.key, counts);
  if (text === null) {
    return 0;
  }

  const parsed = parseM3u(text);
  const candidates = parsed.entries.map((entry) =>
    entryCandidates(library.id, object.key, entry, libraries),
  );
  const tracks = await findTracksByKeys(db, wantedKeys(candidates), calls);

  const matched: EntryTrack[] = [];
  for (const [index, { libraryId, keys }] of candidates.entries()) {
    const inLibrary = tracks.get(libraryId);
    const found = keys.map((key) => inLibrary?.get(key)).find((entry) => entry !== undefined);
    if (found === undefined) {
      counts.unmatched++;
      console.warn(`playlists: ${object.key} lists a path with no track: ${parsed.entries[index]}`);
      continue;
    }

    matched.push(found);
  }

  const held = stored.held.get(object.key);
  const imported: ImportedPlaylist = {
    id,
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
    libraryId: library.id,
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
  // result, which is the ordinary case on every pass after the first. A
  // write through S3 stored its upload time to the second (`secondsOnly`).
  if (matchesStoredPlaylist(held, imported, { secondsOnly: library.kind !== "r2-binding" })) {
    counts.unchanged++;

    return 0;
  }

  calls.statements++;
  return countedBatch(db, upsertPlaylistStatements(db, imported));
}

/** Every key the entries could name, grouped by library, each once, in first-seen order. */
function wantedKeys(candidates: readonly EntryCandidates[]): LibraryKeys[] {
  const byLibrary = new Map<number, Set<string>>();
  for (const { libraryId, keys } of candidates) {
    const into = byLibrary.get(libraryId) ?? new Set<string>();
    byLibrary.set(libraryId, into);
    for (const key of keys) {
      into.add(key);
    }
  }

  return [...byLibrary].map(([libraryId, keys]) => ({ libraryId, keys: [...keys] }));
}

/**
 * The text of one playlist object, or null when storage could not produce
 * it - which is counted as deferred and retried by the next run, exactly as
 * the scan defers an object it could not read.
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
 * Whether the import should read this object of this library. Library 1's
 * `_covers/` holds what the scan writes, and only library 1's (#84,
 * "Covers"); everything else is decided by the playlist suffixes - so audio,
 * artwork and stray files are never mistaken for a playlist.
 */
function isPlaylistObject(object: StoredObject, libraryId: number): boolean {
  return (libraryId !== DEFAULT_LIBRARY_ID || !isCoverKey(object.key)) && isPlaylistKey(object.key);
}

/** The first active library whose id is at least `id`, or null when none is. */
function firstActiveFrom<T extends { readonly id: number }>(
  active: readonly T[],
  id: number,
): T | null {
  return active.find((row) => row.id >= id) ?? null;
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
