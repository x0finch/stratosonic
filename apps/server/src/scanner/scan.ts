/**
 * The Scan: the scheduled pass that keeps D1 in step with the R2 bucket.
 *
 * Music arrives in the bucket out of band, with rclone, as
 * `artist/album/title.ext` (ADR-0004). Nothing tells the server when. So the
 * scan walks the bucket, reads the header of each audio object it has not
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
 * run, with the defaults:
 *
 * | what | calls |
 * | --- | --- |
 * | read the scan's own state (one query, two rows) | 1 |
 * | 3 pages x (`list`, interval query, album-cover query, write batch) | 12 |
 * | 6 extractions x 3 range reads (measured in #21) | 18 |
 * | up to 6 cover `put`s | 6 |
 * | completing a pass: 3 prunes, one bulk cover delete, one summary batch | 5 |
 * | **total** | **42** |
 *
 * The eight calls of headroom are deliberate: three range reads per track is
 * what #21 measured on these formats, not a guarantee - a track carrying a
 * megabyte of artwork needs more chunks - and a page whose sweep deletes more
 * than one statement can bind adds a statement, not a call, but an unusual
 * page could still cost a little more than the table says.
 *
 * Everything a page does goes into **one batch**, including the cursor, so a
 * run that is killed - by the CPU limit, which cannot be caught, or by a
 * subrequest it could not afford - loses at most the page it was in the
 * middle of. That is the whole reason the budget can be an estimate rather
 * than a proof.
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

import { type Database, database } from "../db";
import type { Env } from "../env";
import { isAudioKey, suffixOf } from "../library/audio-formats";
import { r2Source } from "../library/byte-source";
import {
  type EmbeddedCover,
  extractMetadata,
  MetadataError,
  type TrackMetadata,
} from "../library/metadata";
import { coverKeyFor, isCoverKey } from "./covers";
import { type DerivedRows, deriveRows, type LibraryObject } from "./derive";
import {
  chunked,
  deleteTracksStatements,
  findAlbumCovers,
  findTracksInRange,
  pruneEmptyAlbums,
  pruneEmptyArtists,
  pruneOrphanPlaylistEntries,
  recomputeAlbumStatement,
  runBatch,
  type ScanStatement,
  type StoredTrack,
  setAlbumCoverStatement,
  upsertStatements,
} from "./repository";
import {
  addedCounts,
  type BrokenObjects,
  clearScanProgressStatement,
  noCounts,
  readScanState,
  type ScanCounts,
  writeBrokenObjectsStatement,
  writeLastScanSummaryStatement,
  writeScanProgressStatement,
} from "./state";

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

/** R2 refuses a bulk delete of more keys than this. */
const KEYS_PER_BULK_DELETE = 1000;

/** What one run of the scan did. */
export interface ScanRun {
  /** Whether the pass finished: the listing ran out and the sweep ran. */
  readonly completed: boolean;
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
  /** Whether the library already held this track with different bytes. */
  readonly changed: boolean;
}

/** What one listed object turns out to need. */
type Plan =
  /** Not music: artwork, a playlist, a stray file. */
  | { readonly work: "ignore" }
  /** Its etag and size still match the row we hold. */
  | { readonly work: "unchanged" }
  /** Known unreadable at exactly these bytes; not worth a read. */
  | { readonly work: "known-broken" }
  | {
      readonly work: "read";
      readonly object: LibraryObject;
      readonly held: StoredTrack | undefined;
    };

/**
 * Runs one bounded step of the scan and reports what it did.
 *
 * `now` is the instant the run is stamped with - the time the pass was poked
 * at in production, a fixed value in a test. It is what every row's `updatedAt`
 * becomes and what a completed pass records as its finish, so a run is a
 * function of its inputs rather than of the clock.
 *
 * A single object that cannot be read never ends a run: bytes that are not
 * what their suffix promised are counted as broken, remembered against their
 * etag so they are not read again, and passed over; an R2 failure is counted
 * as deferred and left for the next run, which will find the object unknown
 * and try again.
 */
export async function runScan(
  env: Env,
  now: Date = new Date(),
  limits: ScanLimits = DEFAULT_SCAN_LIMITS,
): Promise<ScanRun> {
  const db = database(env);
  const { progress: previous, broken } = await readScanState(db);
  const before = previous?.counts ?? noCounts();
  const startedAt = previous?.startedAt ?? now.getTime();

  const counts = noCounts();
  let cursor = previous?.cursor ?? "";
  let skip = previous?.skip ?? 0;
  let sweptTo = previous?.sweptTo ?? "";
  let extractions = 0;
  let brokenChanged = false;
  let completed = false;

  for (let page = 0; page < limits.pagesPerRun; page++) {
    const listing = await env.MUSIC.list({
      limit: limits.pageSize,
      ...(cursor === "" ? {} : { cursor }),
    });
    const objects = listing.objects;
    const listedKeys = new Set(objects.map(keyOf));
    const lastKey = objects.at(-1)?.key;
    const through = listing.truncated ? (lastKey ?? sweptTo) : null;

    // One query serves both of this page's questions: which of its objects
    // the library already holds, and which rows in the stretch of the key
    // space it covers belong to objects that are gone.
    const inRange = await findTracksInRange(
      db,
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
      counts.removed += removing.length;
      await runBatch(db, [
        ...deleteTracksStatements(
          db,
          removing.map((row) => row.id),
        ),
        ...[...new Set(removing.map((row) => row.albumId))].map((id) =>
          recomputeAlbumStatement(db, id, now),
        ),
        writeScanProgressStatement(db, {
          startedAt,
          cursor,
          skip,
          sweptTo,
          counts: addedCounts(before, counts),
        }),
      ]);

      return { completed: false, startedAt, counts, totals: addedCounts(before, counts) };
    }

    const held = new Map(inRange.map((row) => [row.r2Key, row]));
    const extracted: Extracted[] = [];
    const staleAlbums = new Set<string>();
    let position = skip;
    let interrupted = false;

    for (; position < objects.length; position++) {
      const object = objects[position];
      if (object === undefined) {
        continue;
      }

      const planned = planFor(object, held, broken);
      if (planned.work === "read" && extractions >= limits.extractionsPerRun) {
        interrupted = true;
        break;
      }

      counts.examined++;

      if (planned.work === "ignore") {
        continue;
      }
      if (planned.work === "unchanged") {
        counts.unchanged++;
        continue;
      }
      if (planned.work === "known-broken") {
        counts.broken++;
        continue;
      }

      extractions++;
      const read = await readMetadata(env, planned.object, counts);
      if (!read.read) {
        // Only bytes that will read the same way for ever are worth
        // remembering; a bucket that failed says nothing about them.
        if (read.itsOwnFault) {
          broken.set(planned.object.key, planned.object.etag);
          brokenChanged = true;
        }
        continue;
      }

      if (broken.delete(planned.object.key)) {
        brokenChanged = true;
      }

      const rows = deriveRows(planned.object, read.metadata, now);
      extracted.push({ rows, cover: read.metadata.cover, changed: planned.held !== undefined });
      counts.indexed++;
      if (planned.held === undefined) {
        counts.added++;
      } else {
        counts.updated++;
        // A retagged file can move to another album, leaving the old one a
        // track lighter than it says it is.
        staleAlbums.add(planned.held.albumId);
      }
      staleAlbums.add(rows.album.id);
    }

    const writes: ScanStatement[] = [];
    for (const item of extracted) {
      writes.push(...upsertStatements(db, item.rows, now));
    }
    for (const [albumId, coverKey] of await storeCovers(env, db, extracted, counts)) {
      writes.push(setAlbumCoverStatement(db, albumId, coverKey, now));
    }

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
      counts.removed += missing.length;
      for (const row of missing) {
        staleAlbums.add(row.albumId);
      }
      for (const key of [...broken.keys()]) {
        if (key > sweptTo && (through === null || key <= through) && !listedKeys.has(key)) {
          broken.delete(key);
          brokenChanged = true;
        }
      }

      skip = 0;
      if (listing.truncated) {
        cursor = listing.cursor;
        sweptTo = lastKey ?? sweptTo;
      } else {
        completed = true;
      }
    }

    // After the page's inserts and deletions, because a batch runs in order.
    for (const id of staleAlbums) {
      writes.push(recomputeAlbumStatement(db, id, now));
    }
    if (brokenChanged) {
      writes.push(writeBrokenObjectsStatement(db, broken));
      brokenChanged = false;
    }
    writes.push(
      writeScanProgressStatement(db, {
        startedAt,
        cursor,
        skip,
        sweptTo,
        counts: addedCounts(before, counts),
      }),
    );

    // One transaction: the page's rows, the deletions that go with them, and
    // the cursor that says they are done. A run killed anywhere else redoes
    // this page and nothing more.
    await runBatch(db, writes);

    if (interrupted || completed) {
      break;
    }
  }

  if (completed) {
    await prune(env, db, counts);
    const totals = addedCounts(before, counts);
    await runBatch(db, [
      writeLastScanSummaryStatement(db, { startedAt, finishedAt: now.getTime(), counts: totals }),
      clearScanProgressStatement(db),
    ]);

    return { completed, startedAt, counts, totals };
  }

  return { completed, startedAt, counts, totals: addedCounts(before, counts) };
}

/** What this object needs, before any of it is done. */
function planFor(object: R2Object, held: Map<string, StoredTrack>, broken: BrokenObjects): Plan {
  if (!isTrackObject(object)) {
    return { work: "ignore" };
  }

  const listed = asLibraryObject(object);
  const row = held.get(listed.key);
  if (row !== undefined && row.etag === listed.etag && row.size === listed.size) {
    return { work: "unchanged" };
  }

  if (broken.get(listed.key) === listed.etag) {
    return { work: "known-broken" };
  }

  return { work: "read", object: listed, held: row };
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
 * again.
 */
async function readMetadata(
  env: Env,
  object: LibraryObject,
  counts: ScanCounts,
): Promise<MetadataRead> {
  try {
    const metadata = await extractMetadata(
      r2Source(env.MUSIC, object.key, object.size),
      suffixOf(object.key),
    );

    return { read: true, metadata };
  } catch (error) {
    if (error instanceof MetadataError && error.code === "source-failed") {
      counts.deferred++;
      console.warn(`scan: could not read ${object.key}; retrying next run`, error);

      return { read: false, itsOwnFault: false };
    }

    counts.broken++;
    console.warn(`scan: ${object.key} is not readable audio; skipping`, error);

    return { read: false, itsOwnFault: true };
  }
}

/**
 * Writes the covers this page's tracks earned their albums, and says which
 * album now points where.
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
  env: Env,
  db: Database,
  extracted: readonly Extracted[],
  counts: ScanCounts,
): Promise<Map<string, string>> {
  const written = new Map<string, string>();
  const withCovers = extracted.filter((item) => item.cover !== undefined);
  if (withCovers.length === 0) {
    return written;
  }

  const held = await findAlbumCovers(db, [
    ...new Set(withCovers.map((item) => item.rows.album.id)),
  ]);

  for (const item of withCovers) {
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

    await env.MUSIC.put(key, cover.bytes, { httpMetadata: { contentType: cover.mimeType } });
    counts.coversWritten++;
    written.set(albumId, key);

    // A picture in a new format is stored under a new name, so the old object
    // would otherwise sit in the bucket with nothing pointing at it.
    if (current !== null && current !== key) {
      await env.MUSIC.delete(current);
    }
  }

  return written;
}

/**
 * The end of a pass: albums no track belongs to and artists no album belongs
 * to are removed, together with the cover objects those albums owned, and the
 * playlist entries the sweep left pointing at nothing.
 */
async function prune(env: Env, db: Database, counts: ScanCounts): Promise<void> {
  const albums = await pruneEmptyAlbums(db);
  counts.albumsRemoved += albums.length;

  const orphanedCovers = albums
    .map((row) => row.coverKey)
    .filter((key): key is string => key !== null);
  for (const chunk of chunked(orphanedCovers, KEYS_PER_BULK_DELETE)) {
    await env.MUSIC.delete(chunk);
  }

  counts.artistsRemoved += (await pruneEmptyArtists(db)).length;

  await pruneOrphanPlaylistEntries(db);
}

/**
 * Whether the scan should treat this object as a track. `_covers/` holds what
 * the scan itself writes, and everything else is decided by the one suffix
 * allowlist that also gives a track its content type - so `.m3u` playlists,
 * artwork and stray files are never mistaken for music.
 */
function isTrackObject(object: R2Object): boolean {
  return !isCoverKey(object.key) && isAudioKey(object.key);
}

function asLibraryObject(object: R2Object): LibraryObject {
  return {
    key: object.key,
    size: object.size,
    etag: object.etag,
    uploaded: object.uploaded,
  };
}

function keyOf(object: R2Object): string {
  return object.key;
}
