/**
 * The Scan: the scheduled pass that keeps D1 in step with the R2 bucket.
 *
 * Music arrives in the bucket out of band, with rclone, as
 * `artist/album/title.ext` (ADR-0004). Nothing tells the server when. So the
 * cron entry walks the bucket, reads the header of each audio object it has
 * not seen before, and writes the Artists, Albums and Tracks it finds; tracks
 * whose object has gone are removed, and albums and artists left with nothing
 * are pruned.
 *
 * ## Why a run is bounded
 *
 * A free-tier invocation has 10 ms of CPU and a budget of subrequests, and a
 * library is thousands of files, so one run cannot be one pass. A run
 * therefore does a fixed amount of work and stops, leaving a cursor behind
 * (`state.ts`); the next cron run resumes from it, and the pass completes over
 * as many runs as it takes. Nothing observes a half-finished pass except the
 * tracks that are not indexed yet, and running the same run twice writes the
 * same rows.
 *
 * The three limits below are what "a fixed amount" means, and each is chosen
 * against a different budget:
 *
 * - **`extractionsPerRun`** bounds the expensive path. Reading one track's
 *   header costs two or three R2 range reads (#21) and the CPU to parse them,
 *   which is the scarce resource; twenty-five of them is roughly seventy-five
 *   subrequests, far inside the per-invocation allowance, and is the knob to
 *   turn down first if the 10 ms CPU limit proves binding in production
 *   (ADR-0004).
 * - **`objectsPerRun`** bounds the cheap path. An object whose etag and size
 *   still match costs no read of its own, so a library that has not changed
 *   should sweep through quickly rather than crawl at the extraction rate;
 *   two thousand objects per run is ten listing pages, or about thirty
 *   subrequests.
 * - **`pageSize`** is how many objects one `list()` returns, and therefore
 *   how many keys one `in (...)` lookup carries. SQLite allows 999 bound
 *   parameters; two hundred leaves room and keeps a page's batch small.
 *
 * ## What one run costs
 *
 * Per page: one `list()`, one `select`, one write `batch`, one sweep
 * `delete`. Per changed object: two or three range reads, and one `put` when
 * it gives its album a cover. A completed pass adds two prunes and one
 * summary write.
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
  findAlbumCovers,
  findTracksByKeys,
  pruneEmptyAlbums,
  pruneEmptyArtists,
  pruneOrphanPlaylistEntries,
  recomputeAlbumStatement,
  runBatch,
  type ScanStatement,
  setAlbumCoverStatement,
  sweepMissingTracks,
  upsertStatements,
} from "./repository";
import {
  addCounts,
  clearScanProgress,
  noCounts,
  readScanProgress,
  type ScanCounts,
  writeLastScanSummary,
  writeScanProgress,
} from "./state";

/** How much of the bucket one run gets through. See the notes above. */
export interface ScanLimits {
  /** Objects per `list()`, and therefore per lookup and per batch. */
  readonly pageSize: number;
  /** Objects whose bytes this run may read. */
  readonly extractionsPerRun: number;
  /** Objects this run may look at at all, read or not. */
  readonly objectsPerRun: number;
}

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  pageSize: 200,
  extractionsPerRun: 25,
  objectsPerRun: 2000,
};

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

/**
 * Runs one bounded step of the scan and reports what it did.
 *
 * `now` is the instant the run is stamped with - the cron's scheduled time in
 * production, a fixed value in a test. It is what every row's `updatedAt`
 * becomes and what a completed pass records as its finish, so a run is a
 * function of its inputs rather than of the clock.
 *
 * A single object that cannot be read never ends a run: bytes that are not
 * what their suffix promised are counted as broken and passed over, and an R2
 * failure is counted as deferred and left for the next run, which will find
 * the object unchanged and try again.
 */
export async function runScan(
  env: Env,
  now: Date = new Date(),
  limits: ScanLimits = DEFAULT_SCAN_LIMITS,
): Promise<ScanRun> {
  const db = database(env);
  const previous = await readScanProgress(db);
  const startedAt = previous?.startedAt ?? now.getTime();

  const counts = noCounts();
  /** Albums whose stored song count, duration, size or genre may be stale. */
  const staleAlbums = new Set<string>();

  let cursor = previous?.cursor ?? "";
  let skip = previous?.skip ?? 0;
  let sweptTo = previous?.sweptTo ?? "";
  let extractions = 0;
  let completed = false;

  for (;;) {
    const listing = await env.MUSIC.list({
      limit: limits.pageSize,
      ...(cursor === "" ? {} : { cursor }),
    });
    const objects = listing.objects;

    const stored = await findTracksByKeys(db, objects.slice(skip).filter(isTrackObject).map(keyOf));

    const extracted: Extracted[] = [];
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

      if (!isTrackObject(object)) {
        counts.examined++;
        continue;
      }

      const listed = asLibraryObject(object);
      const held = stored.get(listed.key);
      if (held !== undefined && held.etag === listed.etag && held.size === listed.size) {
        counts.examined++;
        counts.unchanged++;
        continue;
      }

      if (extractions >= limits.extractionsPerRun) {
        interrupted = true;
        break;
      }

      counts.examined++;
      extractions++;

      const metadata = await readMetadata(env, listed, counts);
      if (metadata === null) {
        continue;
      }

      const rows = deriveRows(listed, metadata, now);
      extracted.push({ rows, cover: metadata.cover, changed: held !== undefined });
      counts.indexed++;
      if (held === undefined) {
        counts.added++;
      } else {
        counts.updated++;
        // A retagged file can move to another album, leaving the old one a
        // track lighter than it says it is.
        staleAlbums.add(held.albumId);
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
    await runBatch(db, writes);

    if (interrupted) {
      skip = position;
      break;
    }

    // The page is complete, so the stretch of the key space it covers can be
    // swept of tracks the bucket no longer holds.
    const lastKey = objects.at(-1)?.key;
    const removed = await sweepMissingTracks(
      db,
      sweptTo,
      listing.truncated ? (lastKey ?? sweptTo) : null,
      objects.map(keyOf),
    );
    counts.removed += removed.length;
    for (const row of removed) {
      staleAlbums.add(row.albumId);
    }

    skip = 0;
    if (!listing.truncated) {
      completed = true;
      break;
    }

    cursor = listing.cursor;
    if (lastKey !== undefined) {
      sweptTo = lastKey;
    }
  }

  await runBatch(
    db,
    [...staleAlbums].map((id) => recomputeAlbumStatement(db, id, now)),
  );

  if (completed) {
    await prune(env, db, counts);
  }

  const totals = previous?.counts ?? noCounts();
  addCounts(totals, counts);

  if (completed) {
    await writeLastScanSummary(db, { startedAt, finishedAt: now.getTime(), counts: totals });
    await clearScanProgress(db);
  } else {
    await writeScanProgress(db, { startedAt, cursor, skip, sweptTo, counts: totals });
  }

  return { completed, startedAt, counts, totals };
}

/**
 * Reads one object's metadata, or counts why it could not be read and answers
 * null. The two failures are not the same news (`library/metadata.ts`): bytes
 * that are not what they claim will read the same way for ever, while a
 * bucket that failed may well answer next time, and the object is left
 * unindexed so the next run finds it changed and retries.
 */
async function readMetadata(
  env: Env,
  object: LibraryObject,
  counts: ScanCounts,
): Promise<TrackMetadata | null> {
  try {
    return await extractMetadata(
      r2Source(env.MUSIC, object.key, object.size),
      suffixOf(object.key),
    );
  } catch (error) {
    if (error instanceof MetadataError && error.code === "source-failed") {
      counts.deferred++;
      console.warn(`scan: could not read ${object.key}; retrying next run`, error);
    } else {
      counts.broken++;
      console.warn(`scan: ${object.key} is not readable audio; skipping`, error);
    }

    return null;
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
 * album in hand at once, which a scan spread over many runs does not have,
 * and it would rewrite the object whenever a lower-sorting track appeared.
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
  if (orphanedCovers.length > 0) {
    await env.MUSIC.delete(orphanedCovers);
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
