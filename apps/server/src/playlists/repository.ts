/**
 * The D1 side of the playlist import, and the reads the two playlist
 * endpoints answer from.
 *
 * Three rules shape what is here.
 *
 * **A statement is built, not run.** One playlist's row and all of its
 * entries reach D1 as a single `batch` - one transaction, one subrequest -
 * rather than as a write per entry.
 *
 * **No statement binds more than D1 allows.** The budget and the chunker are
 * the scan's (`scanner/repository.ts`), because the limit belongs to the
 * platform rather than to either pass: a lookup takes `KEYS_PER_STATEMENT`
 * keys at a time, and an entry insert a third as many rows, since each row
 * binds three columns.
 *
 * **Nothing is deleted from a set this module did not see in full.** The
 * sweep is given the keys one listing page offered and the stretch of the key
 * space that page covers, and it removes only playlists inside that stretch -
 * so a listing that failed half way through can never be read as "the rest of
 * the bucket is empty".
 */

import { album, annotation, playlist, playlistTrack, track } from "@stratosonic/db";
import { and, asc, eq, gt, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "../db";
import { annotationColumns, annotationJoin } from "../library/annotations";
import { toSongView } from "../library/repository";
import type { PlaylistView, SongView } from "../library/serializers";
import { chunked, KEYS_PER_STATEMENT } from "../scanner/repository";

/** A statement built now and run later, as part of a batch. */
export type PlaylistStatement = BatchItem<"sqlite">;

/** Three columns per entry row, so a third as many rows fit the same budget. */
const ENTRIES_PER_INSERT = Math.floor(KEYS_PER_STATEMENT / 3);

/** What the importer needs to know about a track an entry may name. */
export interface EntryTrack {
  readonly id: string;
  readonly r2Key: string;
  readonly duration: number;
}

/** What the importer keeps from a playlist it has imported before. */
export interface StoredPlaylist {
  readonly id: string;
  readonly r2Key: string;
  readonly ownerId: string;
  readonly public: boolean;
  readonly comment: string;
  readonly createdAt: Date;
}

/**
 * A stored playlist as the import needs to see it: what it keeps, plus
 * everything the `.m3u` decides - so a pass can tell whether it has anything
 * to write at all (`matchesStoredPlaylist`).
 */
export interface IndexedPlaylist extends StoredPlaylist {
  readonly name: string;
  readonly songCount: number;
  readonly duration: number;
  readonly changedAt: Date;
  /** The tracks it holds, in the order the row lists them. */
  readonly trackIds: readonly string[];
}

/** The tracks these R2 keys name, by key; keys with no track are absent. */
export async function findTracksByKeys(
  db: Database,
  keys: readonly string[],
): Promise<Map<string, EntryTrack>> {
  const found = new Map<string, EntryTrack>();

  for (const chunk of chunked(keys)) {
    const rows = await db
      .select({ id: track.id, r2Key: track.r2Key, duration: track.duration })
      .from(track)
      .where(inArray(track.r2Key, chunk));

    for (const row of rows) {
      found.set(row.r2Key, row);
    }
  }

  return found;
}

/**
 * The playlists already imported from these `.m3u` keys, by key, each with
 * the entries it holds.
 *
 * The entries come with the rows because the import compares them: a pass
 * that finds the stored playlist already equal to what the file says writes
 * nothing, and it cannot know that without them. They cost one statement per
 * hundred playlists rather than one per playlist, since the whole page's ids
 * are looked up at once - and a page of playlists was already one statement
 * per hundred keys here.
 */
export async function findPlaylistsByKeys(
  db: Database,
  keys: readonly string[],
): Promise<Map<string, IndexedPlaylist>> {
  const rows: Omit<IndexedPlaylist, "trackIds">[] = [];

  for (const chunk of chunked(keys)) {
    rows.push(
      ...(await db
        .select({
          id: playlist.id,
          name: playlist.name,
          r2Key: playlist.r2Key,
          ownerId: playlist.ownerId,
          public: playlist.public,
          comment: playlist.comment,
          songCount: playlist.songCount,
          duration: playlist.duration,
          createdAt: playlist.createdAt,
          changedAt: playlist.changedAt,
        })
        .from(playlist)
        .where(inArray(playlist.r2Key, chunk))),
    );
  }

  const entries = await findPlaylistEntryIds(
    db,
    rows.map((row) => row.id),
  );
  const found = new Map<string, IndexedPlaylist>();

  for (const row of rows) {
    found.set(row.r2Key, { ...row, trackIds: entries.get(row.id) ?? [] });
  }

  return found;
}

/**
 * The track ids these playlists hold, in position order, by playlist id; a
 * playlist holding none is absent.
 *
 * The ids are bound, so they are chunked below D1's parameter limit like
 * every other lookup here.
 */
async function findPlaylistEntryIds(
  db: Database,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();

  for (const chunk of chunked(ids)) {
    const rows = await db
      .select({ playlistId: playlistTrack.playlistId, trackId: playlistTrack.trackId })
      .from(playlistTrack)
      .where(inArray(playlistTrack.playlistId, chunk))
      .orderBy(asc(playlistTrack.playlistId), asc(playlistTrack.position));

    for (const row of rows) {
      const held = found.get(row.playlistId);
      if (held === undefined) {
        found.set(row.playlistId, [row.trackId]);
      } else {
        held.push(row.trackId);
      }
    }
  }

  return found;
}

/**
 * The tracks these ids name, by id; ids that name no track are absent.
 *
 * This is `findTracksByKeys` asked the other way round, for the write
 * endpoints: a client sends the track ids it already holds, and the write
 * needs each one's key - which is what goes in the `.m3u` - and its duration.
 * The ids are bound, so they are chunked below D1's parameter limit: a
 * playlist of five hundred songs is six statements, not one that throws.
 */
export async function findTracksByIds(
  db: Database,
  ids: readonly string[],
): Promise<Map<string, EntryTrack>> {
  const found = new Map<string, EntryTrack>();

  for (const chunk of chunked(ids)) {
    const rows = await db
      .select({ id: track.id, r2Key: track.r2Key, duration: track.duration })
      .from(track)
      .where(inArray(track.id, chunk));

    for (const row of rows) {
      found.set(row.id, row);
    }
  }

  return found;
}

/**
 * The tracks one playlist holds, in the order it lists them, with only what a
 * write needs: the id, the key that goes in the `.m3u`, and the duration the
 * row's total is built from.
 *
 * `listPlaylistEntries` below answers the same question for a client, with the
 * album and the caller's annotation joined in for the `<song>` it renders.
 * `updatePlaylist` renders no song - it re-writes the file and the row - so it
 * asks for the three columns it uses and joins nothing. The join is inner, as
 * it is there: an entry pointing at a track that has gone is not an entry the
 * file can name.
 */
export async function listPlaylistEntryTracks(db: Database, id: string): Promise<EntryTrack[]> {
  return db
    .select({ id: track.id, r2Key: track.r2Key, duration: track.duration })
    .from(playlistTrack)
    .innerJoin(track, eq(track.id, playlistTrack.trackId))
    .where(eq(playlistTrack.playlistId, id))
    .orderBy(asc(playlistTrack.position));
}

/** A stored playlist as a write endpoint needs it: everything it must keep. */
export interface WritablePlaylist extends StoredPlaylist {
  readonly name: string;
}

/**
 * The playlist this id names, whoever owns it, or null when there is none.
 *
 * Unlike the reads below, this does not filter by what the caller may *see*:
 * a write endpoint has its own rule - the owner or an admin, Navidrome's
 * `isWritable` - and answering "not found" for a playlist the caller may not
 * write would tell a client to forget a playlist that is still there.
 */
export async function findWritablePlaylist(
  db: Database,
  id: string,
): Promise<WritablePlaylist | null> {
  const rows = await db
    .select({
      id: playlist.id,
      name: playlist.name,
      r2Key: playlist.r2Key,
      ownerId: playlist.ownerId,
      public: playlist.public,
      comment: playlist.comment,
      createdAt: playlist.createdAt,
    })
    .from(playlist)
    .where(eq(playlist.id, id))
    .limit(1);

  return rows[0] ?? null;
}

/** Removes one playlist; its entries cascade with it. */
export async function deletePlaylistRow(db: Database, id: string): Promise<void> {
  await db.delete(playlist).where(eq(playlist.id, id));
}

/** A playlist as one import writes it. */
export interface ImportedPlaylist {
  readonly id: string;
  readonly name: string;
  readonly comment: string;
  readonly ownerId: string;
  readonly public: boolean;
  readonly songCount: number;
  readonly duration: number;
  readonly r2Key: string;
  readonly createdAt: Date;
  readonly changedAt: Date;
  /** The tracks it holds, in the order the file lists them. */
  readonly trackIds: readonly string[];
}

/**
 * Whether the stored playlist already says exactly what this import would
 * write - in which case the import writes nothing at all.
 *
 * The import re-reads and re-resolves every `.m3u` on every pass, which it
 * must (see `import.ts`), but a pass over a bucket nobody has touched then
 * rewrote every row and every entry it had just written: D1 bills per row
 * written, and fourteen playlists of nine hundred entries came to some
 * 176,000 rows a day at a quarter-hourly schedule, against a free tier of
 * 100,000 (#61). Reading the rows first costs one statement per page and
 * makes the pass free.
 *
 * Only the columns the upsert would actually change are compared: the name,
 * the counts, the key, `changed`, and the entries in order. The rest of the
 * row - the owner, the comment, the visibility and `created` - is taken
 * *from* the stored row a line above, so it cannot differ; and comparing a
 * column the upsert leaves alone would be worse than useless, since a row
 * that somehow disagreed there would be rewritten on every pass for ever
 * without the rewrite ever settling it.
 */
export function matchesStoredPlaylist(
  held: IndexedPlaylist | undefined,
  imported: ImportedPlaylist,
): boolean {
  if (held === undefined) {
    return false;
  }

  return (
    held.id === imported.id &&
    held.name === imported.name &&
    held.songCount === imported.songCount &&
    held.duration === imported.duration &&
    held.r2Key === imported.r2Key &&
    held.changedAt.getTime() === imported.changedAt.getTime() &&
    held.trackIds.length === imported.trackIds.length &&
    held.trackIds.every((trackId, position) => trackId === imported.trackIds[position])
  );
}

/**
 * The statements that make the stored playlist equal to what the file says.
 *
 * The entries are deleted and written again rather than reconciled: an `.m3u`
 * is an ordered list with no identity per line, so "the same track moved" and
 * "a different track" are the same edit, and replacing the lot is both
 * simpler and exactly idempotent.
 *
 * What an existing row keeps is what Navidrome keeps when it re-imports a
 * synced playlist (`updatePlaylist` in core/playlists/import.go): its owner,
 * its comment, its visibility and the instant it was first seen. Those are
 * the columns a person - or a write endpoint - can change, and re-reading the
 * file is not a reason to undo that.
 *
 * `writesDetails` is how the write endpoint says it is the person: the
 * comment and the visibility are then taken from what it passed rather than
 * left as they are, because `updatePlaylist` is the one caller whose whole
 * purpose may be to change them. They live nowhere in the `.m3u`, so an
 * import has nothing to say about them and leaves them alone. The owner is
 * not in the set either way: nothing hands a playlist to somebody else.
 */
export function upsertPlaylistStatements(
  db: Database,
  imported: ImportedPlaylist,
  { writesDetails = false }: { readonly writesDetails?: boolean } = {},
): PlaylistStatement[] {
  const statements: PlaylistStatement[] = [
    db
      .insert(playlist)
      .values({
        id: imported.id,
        name: imported.name,
        comment: imported.comment,
        ownerId: imported.ownerId,
        public: imported.public,
        songCount: imported.songCount,
        duration: imported.duration,
        r2Key: imported.r2Key,
        createdAt: imported.createdAt,
        changedAt: imported.changedAt,
      })
      .onConflictDoUpdate({
        target: playlist.id,
        set: {
          name: imported.name,
          songCount: imported.songCount,
          duration: imported.duration,
          r2Key: imported.r2Key,
          changedAt: imported.changedAt,
          ...(writesDetails ? { comment: imported.comment, public: imported.public } : {}),
        },
      }),
    db.delete(playlistTrack).where(eq(playlistTrack.playlistId, imported.id)),
  ];

  let position = 0;
  for (const chunk of chunked(imported.trackIds, ENTRIES_PER_INSERT)) {
    statements.push(
      db.insert(playlistTrack).values(
        chunk.map((trackId) => ({
          playlistId: imported.id,
          trackId,
          position: position++,
        })),
      ),
    );
  }

  return statements;
}

/** A playlist row the sweep looked at. */
export interface SweptPlaylist {
  readonly id: string;
  readonly r2Key: string;
}

/**
 * Removes the playlists of one stretch of the key space whose `.m3u` object
 * the bucket no longer holds, and says which went.
 *
 * This is the deletion sweep, done a listing page at a time, as the scan
 * sweeps its tracks (`scanner/repository.ts`). R2 lists keys in order, so a
 * page is a closed interval: a playlist whose key falls inside it and which
 * the page did not offer has lost its file. `through` is the page's last key,
 * or null for the final page, after which nothing is left.
 *
 * `createdBefore` is the instant the pass began, and only rows older than it
 * are removed. Everything a page saw was listed before the sweep ran, so a
 * playlist a client created in between - its `.m3u` put in the bucket after
 * the listing, its row written straight afterwards - is in the interval and
 * not in the page, and would otherwise be deleted moments after the listener
 * made it, for no fault of its own. Its row is younger than the pass, so it
 * is left alone; the next pass lists its file and imports it like any other.
 *
 * The rows are read before they are deleted rather than deleted by a `not in
 * (...)`, so the number of keys one page carries never has to fit inside a
 * statement's parameter budget.
 */
export async function sweepMissingPlaylists(
  db: Database,
  after: string,
  through: string | null,
  listed: readonly string[],
  createdBefore: Date,
): Promise<SweptPlaylist[]> {
  const inRange = await db
    .select({ id: playlist.id, r2Key: playlist.r2Key })
    .from(playlist)
    .where(
      and(
        gt(playlist.r2Key, after),
        through === null ? undefined : lte(playlist.r2Key, through),
        lt(playlist.createdAt, createdBefore),
      ),
    );

  const stillThere = new Set(listed);
  const gone = inRange.filter((row) => !stillThere.has(row.r2Key));

  for (const chunk of chunked(gone.map((row) => row.id))) {
    // The entries go with them: `playlist_track` cascades on the playlist.
    await db.delete(playlist).where(inArray(playlist.id, chunk));
  }

  return gone;
}

/* --------------------------------------------------------------- reads -- */

/** Who may see a playlist: an admin sees all, everyone else their own and the public ones. */
export interface PlaylistViewer {
  readonly id: string;
  readonly isAdmin: boolean;
}

const playlistColumns = {
  id: playlist.id,
  name: playlist.name,
  comment: playlist.comment,
  public: playlist.public,
  songCount: playlist.songCount,
  duration: playlist.duration,
  createdAt: playlist.createdAt,
  changedAt: playlist.changedAt,
  ownerName: sql<string>`coalesce((select user.user_name from user
    where user.id = playlist.owner_id), '')`,
  // The cover of the earliest entry whose album has one. A playlist has no
  // artwork of its own here - Navidrome answers with a `pl-` id and paints a
  // mosaic of its albums, which needs an image pipeline this server does not
  // have - so it borrows a cover that `getCoverArt` can already serve, and
  // says nothing at all when no entry has one.
  coverAlbumId: sql<string | null>`(select album.id from playlist_track
    join track on track.id = playlist_track.track_id
    join album on album.id = track.album_id
    where playlist_track.playlist_id = playlist.id and album.cover_key is not null
    order by playlist_track.position limit 1)`,
};

/**
 * What a viewer is allowed to see, as Navidrome's `playlistRepository.
 * userFilter` decides it: everything for an admin, and otherwise the public
 * playlists and the viewer's own.
 */
function visibleTo(viewer: PlaylistViewer) {
  return viewer.isAdmin
    ? undefined
    : or(eq(playlist.public, true), eq(playlist.ownerId, viewer.id));
}

/**
 * Every playlist this viewer may see, by name.
 *
 * Navidrome's `GetPlaylists` asks for `Sort: "name"` and nothing else; the id
 * breaks a tie so two playlists of the same name keep one order rather than
 * whatever the database happens to return. The list has no paging and no
 * filter: a client treats it as the authoritative set and deletes what is
 * missing from it (#9), so it is always complete.
 */
export async function listPlaylists(db: Database, viewer: PlaylistViewer): Promise<PlaylistView[]> {
  return db
    .select(playlistColumns)
    .from(playlist)
    .where(visibleTo(viewer))
    .orderBy(asc(playlist.name), asc(playlist.id));
}

/** One playlist, or null when there is none with this id the viewer may see. */
export async function findPlaylist(
  db: Database,
  viewer: PlaylistViewer,
  id: string,
): Promise<PlaylistView | null> {
  const rows = await db
    .select(playlistColumns)
    .from(playlist)
    .where(and(eq(playlist.id, id), visibleTo(viewer)))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * A playlist's tracks in the order it lists them, each with the album name
 * and cover a `<song>` carries. The join is inner: an entry pointing at a
 * track that has gone is not an entry a client can play, and the scan's sweep
 * removes those rows anyway.
 */
export async function listPlaylistEntries(
  db: Database,
  id: string,
  userId: string,
): Promise<SongView[]> {
  const rows = await db
    .select({ track, albumName: album.name, albumCoverKey: album.coverKey, ...annotationColumns })
    .from(playlistTrack)
    .innerJoin(track, eq(track.id, playlistTrack.trackId))
    .leftJoin(album, eq(album.id, track.albumId))
    .leftJoin(annotation, annotationJoin(userId, "track", track.id))
    .where(eq(playlistTrack.playlistId, id))
    .orderBy(asc(playlistTrack.position));

  return rows.map(toSongView);
}

/** Runs queued statements as one D1 batch. An empty queue does nothing. */
export async function runBatch(
  db: Database,
  statements: readonly PlaylistStatement[],
): Promise<void> {
  const [first, ...rest] = statements;
  if (first === undefined) {
    return;
  }

  await db.batch([first, ...rest]);
}
