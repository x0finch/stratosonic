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

import { playlistId } from "@stratosonic/db";
import { type Database, database } from "../db";
import type { Env } from "../env";
import { isCoverKey } from "../scanner/covers";
import { findFirstAdmin } from "../users/repository";
import { entryKeyCandidates, isPlaylistKey, parseM3u, playlistNameFromKey } from "./m3u";
import {
  type EntryTrack,
  findPlaylistsByKeys,
  findTracksByKeys,
  type ImportedPlaylist,
  type IndexedPlaylist,
  matchesStoredPlaylist,
  runBatch,
  sweepMissingPlaylists,
  upsertPlaylistStatements,
} from "./repository";
import {
  addPlaylistImportCounts,
  clearPlaylistImportProgress,
  noPlaylistImportCounts,
  type PlaylistImportCounts,
  readPlaylistImportProgress,
  writePlaylistImportProgress,
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

/** What one run of the import did. */
export interface PlaylistImportRun {
  /** Whether the pass finished: the listing ran out and the sweep ran. */
  readonly completed: boolean;
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
 */
export async function importPlaylists(
  env: Env,
  now: Date = new Date(),
  limits: PlaylistImportLimits = DEFAULT_PLAYLIST_IMPORT_LIMITS,
): Promise<PlaylistImportRun> {
  const db = database(env);
  const previous = await readPlaylistImportProgress(db);
  const startedAt = previous?.startedAt ?? now.getTime();
  const before = previous?.counts ?? noPlaylistImportCounts();
  const counts = noPlaylistImportCounts();
  counts.steps = 1;

  const owner = await findFirstAdmin(db);
  if (owner === null) {
    // Navidrome defers the import in the same situation (its playlist phase
    // records a pending flag when there is no admin yet). Here the bootstrap
    // has already run by the time the cron reaches this, so this is a guard
    // rather than a state anything should reach.
    console.warn("playlists: no admin user yet; nothing imported");

    return { completed: false, startedAt, counts, totals: totalsOf(before, counts) };
  }

  let cursor = previous?.cursor ?? "";
  let skip = previous?.skip ?? 0;
  let sweptTo = previous?.sweptTo ?? "";
  let imports = 0;
  let completed = false;

  for (;;) {
    const listing = await env.MUSIC.list({
      limit: limits.pageSize,
      ...(cursor === "" ? {} : { cursor }),
    });
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

      await importOne(env, db, object, owner.id, stored.get(object.key), counts);
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
      listing.truncated ? (lastKey ?? sweptTo) : null,
      pageKeys,
      new Date(startedAt),
    );
    counts.removed += removed.length;

    skip = 0;
    if (!listing.truncated) {
      completed = true;
      break;
    }

    cursor = listing.cursor;
    if (lastKey !== undefined) {
      sweptTo = lastKey;
    }

    // Written per page, not per run: a run the platform cuts short must not
    // cost more than the page it was in.
    await writePlaylistImportProgress(db, {
      startedAt,
      cursor,
      skip,
      sweptTo,
      counts: totalsOf(before, counts),
    });
  }

  const totals = totalsOf(before, counts);

  if (completed) {
    await clearPlaylistImportProgress(db);
  } else {
    await writePlaylistImportProgress(db, { startedAt, cursor, skip, sweptTo, counts: totals });
  }

  return { completed, startedAt, counts, totals };
}

/**
 * Reads one `.m3u` and makes the library agree with it.
 *
 * The entries are resolved in one lookup for the whole file rather than one
 * per line: a playlist of two hundred songs is then two D1 reads, not two
 * hundred.
 */
async function importOne(
  env: Env,
  db: Database,
  object: R2Object,
  adminId: string,
  held: IndexedPlaylist | undefined,
  counts: PlaylistImportCounts,
): Promise<void> {
  const text = await readPlaylistText(env, object.key, counts);
  if (text === null) {
    return;
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
    id: playlistId(object.key),
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

    return;
  }

  await runBatch(db, upsertPlaylistStatements(db, imported));
}

/**
 * The text of one playlist object, or null when R2 could not produce it -
 * which is counted as deferred and retried by the next run, exactly as the
 * scan defers an object it could not read.
 */
async function readPlaylistText(
  env: Env,
  key: string,
  counts: PlaylistImportCounts,
): Promise<string | null> {
  try {
    const object = await env.MUSIC.get(key);
    if (object === null) {
      // Deleted between the listing and now. The next pass will not list it,
      // and the sweep will remove whatever it left behind.
      counts.deferred++;

      return null;
    }

    return await object.text();
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
function isPlaylistObject(object: R2Object): boolean {
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
