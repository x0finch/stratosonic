/**
 * The D1 side of a scan: what it looks up before reading an object, the rows
 * it writes, and the deletions that keep the library in step with the bucket.
 *
 * Two rules shape everything here.
 *
 * **A write is a statement, not a round trip.** The upserts return the
 * statement to run rather than running it, so a whole page of objects reaches
 * D1 in one `batch` - one transaction, one subrequest - instead of three per
 * track. Only the reads and the deletions, whose results the scan has to see,
 * are awaited on their own.
 *
 * **A lookup covers a page, not a row.** A page of listed objects is resolved
 * against the `track` table in a single `in (...)` query, so an unchanged
 * library costs one read per page rather than one per file.
 */

import { type Album, album, artist, playlistTrack, type Track, track } from "@stratosonic/db";
import { and, eq, gt, inArray, lte, notInArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "../db";
import type { DerivedRows } from "./derive";

/** A statement built now and run later, as part of a batch. */
export type ScanStatement = BatchItem<"sqlite">;

/** What the scan needs to know about a track it may already hold. */
export interface StoredTrack {
  readonly id: string;
  readonly r2Key: string;
  readonly albumId: string;
  readonly etag: string;
  readonly size: number;
}

/**
 * The tracks the library already holds for these keys, by key.
 *
 * D1 binds each key as a parameter and SQLite allows 999 of them, so a caller
 * asks about one listing page at a time; the scan's page size is set well
 * under that.
 */
export async function findTracksByKeys(
  db: Database,
  keys: readonly string[],
): Promise<Map<string, StoredTrack>> {
  if (keys.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      id: track.id,
      r2Key: track.r2Key,
      albumId: track.albumId,
      etag: track.etag,
      size: track.size,
    })
    .from(track)
    .where(inArray(track.r2Key, [...keys]));

  return new Map(rows.map((row) => [row.r2Key, row]));
}

/**
 * The cover each of these albums already has, for the albums that exist. An
 * album missing from the map has no row yet, so it has no cover either; one
 * present with `null` has a row and no artwork.
 */
export async function findAlbumCovers(
  db: Database,
  ids: readonly string[],
): Promise<Map<string, string | null>> {
  if (ids.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({ id: album.id, coverKey: album.coverKey })
    .from(album)
    .where(inArray(album.id, [...ids]));

  return new Map(rows.map((row) => [row.id, row.coverKey]));
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
 * It is a single statement so a page's worth of albums can be recomputed in
 * the same batch as the rows that made them stale. Every column is written
 * from the `track` table, so running it twice changes nothing.
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
 * Deletes the tracks of one stretch of the key space that the bucket no
 * longer holds, and hands them back so their albums can be recomputed.
 *
 * This is the deletion sweep, done a listing page at a time rather than all at
 * the end. R2 lists keys in order, so a page is a closed interval of the key
 * space: every key between the previous page's last and this page's last that
 * is *not* in this page belongs to an object that has gone. Sweeping that way
 * needs no memory of the pass beyond one key, which is what lets a scan spread
 * over many cron runs still delete accurately.
 *
 * `through` is the page's last key, or null for the final page - after which
 * nothing is left, so everything beyond `after` that was not listed is gone.
 */
export async function sweepMissingTracks(
  db: Database,
  after: string,
  through: string | null,
  listed: readonly string[],
): Promise<Track[]> {
  return db
    .delete(track)
    .where(
      and(
        gt(track.r2Key, after),
        through === null ? undefined : lte(track.r2Key, through),
        listed.length === 0 ? undefined : notInArray(track.r2Key, [...listed]),
      ),
    )
    .returning();
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
 * subrequest. D1 insists on at least one statement, so an empty queue - a page
 * of nothing but unchanged files - does nothing at all.
 */
export async function runBatch(db: Database, statements: readonly ScanStatement[]): Promise<void> {
  const [first, ...rest] = statements;
  if (first === undefined) {
    return;
  }

  await db.batch([first, ...rest]);
}
