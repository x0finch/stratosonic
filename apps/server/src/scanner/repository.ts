/**
 * The D1 side of a scan: what it looks up before reading an object, the rows
 * it writes, and the deletions that keep the library in step with the bucket.
 *
 * Three rules shape everything here, and all three come from the same place -
 * on the Workers free plan **a D1 query is a subrequest, and an invocation
 * has fifty of them** (developers.cloudflare.com/workers/platform/limits,
 * "Subrequests": a subrequest is any request to a Cloudflare service such as
 * R2, KV or D1).
 *
 * **A write is a statement, not a round trip.** The writes return the
 * statement to run rather than running it, so a whole listing page - its
 * upserts, its deletions, its album recomputes and the scan's own cursor -
 * reaches D1 as one `batch`. A batch is "a single call to the database"
 * (D1's Worker API reference), so it is one subrequest, and it is one
 * transaction, so a page's rows and the cursor that stands for them commit
 * together or not at all.
 *
 * **A lookup covers a key range, not a list of keys.** `findTracksInRange`
 * binds two parameters whatever the page holds. That is not only cheap: **D1
 * allows at most 100 bound parameters per query** (developers.cloudflare.com
 * /d1/platform/limits), so a `where r2_key in (...)` over a listing page
 * would throw `too many SQL variables` in production for any page above a
 * hundred objects - and pass every test, because Miniflare is real SQLite,
 * whose limit is 999.
 *
 * **Anything that must bind per row is chunked** below that hundred, which is
 * what `KEYS_PER_STATEMENT` is for.
 */

import { type Album, album, artist, playlistTrack, track } from "@stratosonic/db";
import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { D1_MAX_BOUND_PARAMETERS } from "../d1-limits";
import type { Database } from "../db";
import type { DerivedRows } from "./derive";

/** A statement built now and run later, as part of a batch. */
export type ScanStatement = BatchItem<"sqlite">;

/** How many ids or keys one statement may bind, with room for the rest. */
export const KEYS_PER_STATEMENT = D1_MAX_BOUND_PARAMETERS - 10;

/** What the scan needs to know about a track it may already hold. */
export interface StoredTrack {
  readonly id: string;
  readonly r2Key: string;
  readonly albumId: string;
  readonly etag: string;
  readonly size: number;
}

/**
 * The tracks whose key falls in `(after, through]`, in key order, at most
 * `limit` of them.
 *
 * One query answers both of a page's questions. R2 lists keys in order, so a
 * listing page occupies exactly such an interval: the rows that come back
 * either belong to an object the page listed - and say whether its bytes have
 * changed - or belong to an object that is no longer there, and are what the
 * deletion sweep removes.
 *
 * `through` is null for the final page, whose interval runs to the end of the
 * key space. The `limit` is what keeps an interval holding a huge deletion
 * from returning the whole table; the caller notices a full result and deals
 * with the backlog before indexing anything.
 */
export async function findTracksInRange(
  db: Database,
  after: string,
  through: string | null,
  limit: number,
): Promise<StoredTrack[]> {
  return db
    .select({
      id: track.id,
      r2Key: track.r2Key,
      albumId: track.albumId,
      etag: track.etag,
      size: track.size,
    })
    .from(track)
    .where(and(gt(track.r2Key, after), through === null ? undefined : lte(track.r2Key, through)))
    .orderBy(track.r2Key)
    .limit(limit);
}

/**
 * The cover each of these albums already has, for the albums that exist. An
 * album missing from the map has no row yet, so it has no cover either; one
 * present with `null` has a row and no artwork.
 *
 * The ids are bound, so they are chunked - though a page cannot produce more
 * albums than it has extractions, which is far below the limit.
 */
export async function findAlbumCovers(
  db: Database,
  ids: readonly string[],
): Promise<Map<string, string | null>> {
  const found = new Map<string, string | null>();

  for (const chunk of chunked(ids)) {
    const rows = await db
      .select({ id: album.id, coverKey: album.coverKey })
      .from(album)
      .where(inArray(album.id, chunk));

    for (const row of rows) {
      found.set(row.id, row.coverKey);
    }
  }

  return found;
}

/**
 * The statements that write one track's three rows.
 *
 * The artist and the album are upserted rather than inserted-if-absent: a
 * retagged file that keeps its album's identity - the artist, name and year
 * its id is derived from - may still have changed the spelling of any of
 * them, and the row should follow. What is deliberately *not* overwritten is
 * the album's `coverKey`, which the cover step owns, and its `createdAt`,
 * genre and aggregates, which `recomputeAlbumStatement` derives from the
 * album's tracks.
 */
export function upsertStatements(db: Database, rows: DerivedRows, now: Date): ScanStatement[] {
  return [
    db
      .insert(artist)
      .values(rows.artist)
      .onConflictDoUpdate({
        target: artist.id,
        set: { name: rows.artist.name, updatedAt: now },
      }),
    db
      .insert(album)
      .values(rows.album)
      .onConflictDoUpdate({
        target: album.id,
        set: {
          name: rows.album.name,
          artistId: rows.album.artistId,
          albumArtist: rows.album.albumArtist,
          year: rows.album.year,
          updatedAt: now,
        },
      }),
    db
      .insert(track)
      .values(rows.track)
      .onConflictDoUpdate({
        target: track.id,
        set: {
          r2Key: rows.track.r2Key,
          title: rows.track.title,
          albumId: rows.track.albumId,
          artistId: rows.track.artistId,
          artist: rows.track.artist,
          albumArtist: rows.track.albumArtist,
          trackNumber: rows.track.trackNumber,
          discNumber: rows.track.discNumber,
          year: rows.track.year,
          duration: rows.track.duration,
          bitRate: rows.track.bitRate,
          size: rows.track.size,
          suffix: rows.track.suffix,
          genre: rows.track.genre,
          etag: rows.track.etag,
          createdAt: rows.track.createdAt,
          updatedAt: rows.track.updatedAt,
        },
      }),
  ];
}

/** Points an album at the cover object the scan has just written. */
export function setAlbumCoverStatement(
  db: Database,
  id: string,
  coverKey: string,
  now: Date,
): ScanStatement {
  return db.update(album).set({ coverKey, updatedAt: now }).where(eq(album.id, id));
}

/**
 * Removes the tracks the sweep found missing, in statements that bind at most
 * `KEYS_PER_STATEMENT` ids each.
 *
 * They are statements rather than a call so they can go in the page's batch:
 * a deletion that commits without the cursor that covered it would be redone
 * harmlessly, but a cursor that commits without its deletions would carry the
 * sweep past rows nothing will look at again until the next pass.
 */
export function deleteTracksStatements(db: Database, ids: readonly string[]): ScanStatement[] {
  return chunked(ids).map((chunk) => db.delete(track).where(inArray(track.id, chunk)));
}

/**
 * Brings one album's stored aggregates back in line with its tracks.
 *
 * Navidrome recomputes the same values from the album's media files
 * (`model/mediafile.go`, `MediaFiles.ToAlbum`): the song count is how many
 * there are, the duration and size are their sums, and the album's `created`
 * is the oldest of them - which for us is the earliest upload. The genre is
 * the one most of its tracks carry, which is Navidrome's "most common genre"
 * for an album, with the name breaking a tie so the answer does not depend on
 * row order.
 *
 * It belongs in the same batch as the rows that made it stale, and after
 * them: the statements of a batch run in order, so this sees the page's
 * inserts and deletions. Every column is written from the `track` table, so
 * running it twice changes nothing.
 *
 * Each subquery is written out rather than composed from the schema objects,
 * and qualifies `album.id` by hand: the `UPDATE` names one table, so Drizzle
 * would render that correlation as a bare `id`, which SQLite would resolve
 * against `track` inside the subquery and quietly match nothing. It is an
 * `update ... set` rather than raw SQL because Drizzle's D1 driver can only
 * put a *prepared* statement in a batch - a raw one carrying parameters has
 * nothing to bind them to.
 */
export function recomputeAlbumStatement(db: Database, id: string, now: Date): ScanStatement {
  const ofThisAlbum = sql`from track where track.album_id = album.id`;

  return db
    .update(album)
    .set({
      songCount: sql`(select count(*) ${ofThisAlbum})`,
      duration: sql`(select coalesce(sum(track.duration), 0) ${ofThisAlbum})`,
      size: sql`(select coalesce(sum(track.size), 0) ${ofThisAlbum})`,
      createdAt: sql`(select coalesce(min(track.created_at), album.created_at) ${ofThisAlbum})`,
      genre: sql`(select track.genre ${ofThisAlbum} and track.genre is not null
        group by track.genre order by count(*) desc, track.genre limit 1)`,
      updatedAt: now,
    })
    .where(eq(album.id, id));
}

/**
 * Albums no track belongs to any more. They are returned whole so the cover
 * objects they owned can be removed from R2 as well.
 */
export async function pruneEmptyAlbums(db: Database): Promise<Album[]> {
  return db
    .delete(album)
    .where(sql`not exists (select 1 from track where track.album_id = album.id)`)
    .returning();
}

/** Artists no album belongs to any more. Run after the albums are pruned. */
export async function pruneEmptyArtists(db: Database): Promise<{ id: string }[]> {
  return db
    .delete(artist)
    .where(sql`not exists (select 1 from album where album.artist_id = artist.id)`)
    .returning({ id: artist.id });
}

/**
 * Playlist entries left pointing at a track the sweep removed.
 *
 * The schema leaves this to the scan on purpose: an entry's parent is its
 * playlist, not its track, so nothing cascades when a file leaves the bucket.
 * The playlist's own song count is the importer's business and is put right
 * when it next reads the `.m3u`.
 */
export async function pruneOrphanPlaylistEntries(db: Database): Promise<void> {
  await db
    .delete(playlistTrack)
    .where(sql`not exists (select 1 from track where track.id = playlist_track.track_id)`);
}

/**
 * Runs queued statements as one D1 batch, which is one transaction and one
 * subrequest. D1 insists on at least one statement, so an empty queue does
 * nothing at all.
 */
export async function runBatch(db: Database, statements: readonly ScanStatement[]): Promise<void> {
  const [first, ...rest] = statements;
  if (first === undefined) {
    return;
  }

  await db.batch([first, ...rest]);
}

/** Splits values into groups small enough for one statement to bind. */
export function chunked<T>(values: readonly T[], size = KEYS_PER_STATEMENT): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    chunks.push(values.slice(start, start + size));
  }

  return chunks;
}
