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

import {
  album,
  annotation,
  type Library,
  library,
  playlist,
  playlistTrack,
  track,
} from "@stratosonic/db";
import { and, asc, eq, gt, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "../db";
import { annotationColumns, annotationJoin } from "../library/annotations";
import { toSongView } from "../library/repository";
import { type LibraryScope, libraryFilter, scopeParameters } from "../library/scope";
import type { PlaylistView, SongView } from "../library/serializers";
import { rowsWrittenBy } from "../scanner/budget";
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
  /** Its library, which says how a written `.m3u` spells it (`playlistLine`). */
  readonly libraryId: number;
}

/**
 * The D1 round trips a caller has made, which the import counts against its
 * step's subrequest budget (`PlaylistImportLimits.subrequestsPerRun`): a
 * statement sent alone, or a `db.batch` of any length, is one. Each lookup
 * below adds the round trips it made.
 */
export interface StatementTally {
  statements: number;
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

/** Some keys of one library, as a lookup or a deletion names them. */
export interface LibraryKeys {
  readonly libraryId: number;
  readonly keys: readonly string[];
}

/** The tracks found by key, by library and then by key. */
export type TracksByKey = ReadonlyMap<number, ReadonlyMap<string, EntryTrack>>;

/**
 * The tracks these keys name, by library and key; keys with no track are
 * absent.
 *
 * Keys are unique per library (migration 0009), so every key is looked up
 * with its library, which is also what lets `(library_id, r2_key)` serve it.
 * A playlist's entries may name several libraries (#84, "Playlists across
 * libraries"), and they are still **one statement per file**: one OR'd
 * `(library_id = ? and r2_key in (...))` group per library, chunked as
 * `keyStatements` says. A file naming one library is v0.5.0's lookup with
 * its library named, chunked as it was.
 *
 * **One round trip per file, whatever its length.** A long file needs a
 * statement per ninety candidate keys, and a relative line has two, so a
 * thousand-line file is two dozen statements: they go in one `db.batch`,
 * one subrequest, as every other write here goes (`countedBatch`), so a
 * file costs the import's step what `IMPORT_SUBREQUESTS` says. A file of one
 * statement sends it alone, as v0.5.0 did.
 */
export async function findTracksByKeys(
  db: Database,
  wanted: readonly LibraryKeys[],
  tally: StatementTally = { statements: 0 },
): Promise<TracksByKey> {
  const found = new Map<number, Map<string, EntryTrack>>();
  const [first, ...rest] = keyStatements(wanted).map((groups) =>
    db
      .select({
        id: track.id,
        r2Key: track.r2Key,
        duration: track.duration,
        libraryId: track.libraryId,
      })
      .from(track)
      .where(
        or(
          ...groups.map((group) =>
            and(eq(track.libraryId, group.libraryId), inArray(track.r2Key, [...group.keys])),
          ),
        ),
      ),
  );
  if (first === undefined) {
    return found;
  }

  tally.statements++;
  const results = rest.length === 0 ? [await first] : await db.batch([first, ...rest]);
  for (const rows of results) {
    for (const row of rows) {
      const inLibrary = found.get(row.libraryId) ?? new Map<string, EntryTrack>();
      found.set(row.libraryId, inLibrary);
      inLibrary.set(row.r2Key, row);
    }
  }

  return found;
}

/**
 * The statements a lookup by key sends, each as the library groups it ORs.
 * A statement binds at most `KEYS_PER_STATEMENT` keys plus one, each group's
 * library id counting as one of them, so one library's keys chunk exactly
 * as they did before any other library existed (`KEYS_PER_STATEMENT` keys
 * and the id), well below D1's hundred. A library with no key is left out.
 */
export function keyStatements(wanted: readonly LibraryKeys[]): LibraryKeys[][] {
  const most = KEYS_PER_STATEMENT + 1;
  const statements: LibraryKeys[][] = [];
  let current: LibraryKeys[] = [];
  let bound = 0;

  for (const { libraryId, keys } of wanted) {
    let start = 0;
    while (start < keys.length) {
      // A group binds its library id and at least one key.
      if (bound + 2 > most) {
        statements.push(current);
        current = [];
        bound = 0;
      }
      const taken = keys.slice(start, start + most - bound - 1);
      current.push({ libraryId, keys: taken });
      bound += taken.length + 1;
      start += taken.length;
    }
  }
  if (current.length > 0) {
    statements.push(current);
  }

  return statements;
}

/** The playlists already imported from some keys of one library, and the ids another library holds. */
export interface PlaylistsByKey {
  /** The library's playlists, by key, each with its entries. */
  readonly held: ReadonlyMap<string, IndexedPlaylist>;
  /**
   * Of the ids asked about, those whose row is another library's: an upsert
   * of one would be refused by its collision guard (`upsertPlaylistStatements`),
   * so the import must write neither it nor its entries (#84, "Entity ids").
   */
  readonly foreign: ReadonlySet<string>;
}

/**
 * The playlists already imported from these `.m3u` keys of one library, by
 * key, each with the entries it holds, and which of the ids in `askAbout`
 * are another library's rows.
 *
 * The entries come with the rows because the import compares them: a pass
 * that finds the stored playlist already equal to what the file says writes
 * nothing, and it cannot know that without them. They cost one statement per
 * hundred playlists rather than one per playlist, since every id is looked up
 * at once - and the rows themselves were already one statement per hundred
 * keys here.
 *
 * `askAbout` is the ids the import is about to write that another library
 * may already hold (ADR-0009's collision), looked up in the statement that
 * reads the keys: none on the fast path, so a library-1 lookup is the
 * statement it always was.
 *
 * The caller passes the playlists it is about to import, not every playlist
 * its listing page offered: the entries of a playlist this run will not reach
 * are rows read for nothing, and a run reads at most `importsPerRun` of them.
 */
export async function findPlaylistsByKeys(
  db: Database,
  libraryId: number,
  keys: readonly string[],
  askAbout: readonly string[] = [],
  tally: StatementTally = { statements: 0 },
): Promise<PlaylistsByKey> {
  const rows: (Omit<IndexedPlaylist, "trackIds"> & { libraryId: number })[] = [];
  // Asking about ids too, a statement binds both, so each gets half.
  const size = askAbout.length === 0 ? KEYS_PER_STATEMENT : Math.floor(KEYS_PER_STATEMENT / 2);
  const keyChunks = chunked(keys, size);
  const idChunks = chunked(askAbout, size);

  for (let index = 0; index < Math.max(keyChunks.length, idChunks.length); index++) {
    const keyChunk = keyChunks[index] ?? [];
    const idChunk = idChunks[index] ?? [];
    const byKey =
      keyChunk.length === 0
        ? undefined
        : and(eq(playlist.libraryId, libraryId), inArray(playlist.r2Key, keyChunk));
    const byId = idChunk.length === 0 ? undefined : inArray(playlist.id, idChunk);
    rows.push(
      ...(await db
        .select({
          id: playlist.id,
          name: playlist.name,
          r2Key: playlist.r2Key,
          libraryId: playlist.libraryId,
          ownerId: playlist.ownerId,
          public: playlist.public,
          comment: playlist.comment,
          songCount: playlist.songCount,
          duration: playlist.duration,
          createdAt: playlist.createdAt,
          changedAt: playlist.changedAt,
        })
        .from(playlist)
        .where(byId === undefined ? byKey : or(byKey, byId))),
    );
    tally.statements++;
  }

  const foreign = new Set<string>();
  const own = new Map<string, Omit<IndexedPlaylist, "trackIds">>();
  for (const { libraryId: rowLibrary, ...row } of rows) {
    if (rowLibrary === libraryId) {
      own.set(row.id, row);
    } else {
      foreign.add(row.id);
    }
  }

  const entries = await findPlaylistEntryIds(db, [...own.keys()], tally);
  const held = new Map<string, IndexedPlaylist>();

  for (const row of own.values()) {
    held.set(row.r2Key, { ...row, trackIds: entries.get(row.id) ?? [] });
  }

  return { held, foreign };
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
  tally: StatementTally,
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();

  for (const chunk of chunked(ids)) {
    const rows = await db
      .select({ playlistId: playlistTrack.playlistId, trackId: playlistTrack.trackId })
      .from(playlistTrack)
      .where(inArray(playlistTrack.playlistId, chunk))
      .orderBy(asc(playlistTrack.playlistId), asc(playlistTrack.position));
    tally.statements++;

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
 * The ids are bound, so they are chunked below D1's parameter limit, less
 * what the scope binds: a playlist of five hundred songs is six statements,
 * not one that throws.
 *
 * A track out of the caller's libraries is absent, as an unknown one is, so
 * a write naming it is refused with the same "Song not found" (#84).
 * Navidrome drops such ids silently instead (`keepAccessible`).
 */
export async function findTracksByIds(
  db: Database,
  ids: readonly string[],
  scope: LibraryScope,
): Promise<Map<string, EntryTrack>> {
  const found = new Map<string, EntryTrack>();

  for (const chunk of chunked(ids, KEYS_PER_STATEMENT - scopeParameters(scope))) {
    const rows = await db
      .select({
        id: track.id,
        r2Key: track.r2Key,
        duration: track.duration,
        libraryId: track.libraryId,
      })
      .from(track)
      .where(and(inArray(track.id, chunk), libraryFilter(scope, track.libraryId)));

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
 * asks for the columns it uses and joins nothing. The join is inner, as it
 * is there: an entry pointing at a track that has gone is not an entry the
 * file can name.
 *
 * **Every entry is read, whoever asks** (#84): a listener who sees fewer
 * libraries than the playlist holds must not drop the entries they cannot
 * see by editing it. Each entry says its library, so the edit can tell
 * which positions the caller saw (`songIndexToRemove`).
 */
export async function listPlaylistEntryTracks(
  db: Database,
  id: string,
): Promise<StoredEntryTrack[]> {
  return db
    .select({
      id: track.id,
      r2Key: track.r2Key,
      duration: track.duration,
      libraryId: track.libraryId,
    })
    .from(playlistTrack)
    .innerJoin(track, eq(track.id, playlistTrack.trackId))
    .where(eq(playlistTrack.playlistId, id))
    .orderBy(asc(playlistTrack.position));
}

/** A playlist's entry as `updatePlaylist` reads it: the track and its library. */
export type StoredEntryTrack = EntryTrack;

/** A stored playlist as a write endpoint needs it: everything it must keep. */
export interface WritablePlaylist extends StoredPlaylist {
  readonly name: string;
  /** The library whose bucket holds its `.m3u`, where every write of it goes (#84). */
  readonly libraryId: number;
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
      libraryId: playlist.libraryId,
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

/** A library row as a playlist write reads it: where its bucket is, and whether it may be written. */
export type PlaylistLibraryRow = Pick<
  Library,
  "id" | "kind" | "path" | "endpoint" | "bucket" | "credentials" | "writable" | "state"
>;

/**
 * The row of the library a playlist's file lives in, or null when there is
 * none, and every library's path, in one round trip: what `updatePlaylist`
 * and `deletePlaylist` need to reach a library other than the bound one, to
 * refuse a read-only one, and to spell the other libraries' tracks in its
 * file (#84). It is read only for such a library, so a library-1 write runs
 * v0.5.0's statements.
 */
export async function findPlaylistLibrary(
  db: Database,
  libraryId: number,
): Promise<{ readonly row: PlaylistLibraryRow | null; readonly paths: Map<number, string> }> {
  const [rows, paths] = await db.batch([
    db
      .select({
        id: library.id,
        kind: library.kind,
        path: library.path,
        endpoint: library.endpoint,
        bucket: library.bucket,
        credentials: library.credentials,
        writable: library.writable,
        state: library.state,
      })
      .from(library)
      .where(eq(library.id, libraryId))
      .limit(1),
    db.select({ id: library.id, path: library.path }).from(library),
  ]);

  return { row: rows[0] ?? null, paths: new Map(paths.map((each) => [each.id, each.path])) };
}

/**
 * The paths of these libraries, by id: how a written `.m3u` spells a track
 * of a library other than its own (`playlistLine`). Nothing is read for no
 * id, which is every write whose tracks are all in the playlist's library.
 */
export async function findLibraryPaths(
  db: Database,
  ids: readonly number[],
): Promise<Map<number, string>> {
  if (ids.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({ id: library.id, path: library.path })
    .from(library)
    .where(inArray(library.id, [...ids]));

  return new Map(rows.map((row) => [row.id, row.path]));
}

/** Removes one playlist; its entries cascade with it. */
export async function deletePlaylistRow(db: Database, id: string): Promise<void> {
  await db.delete(playlist).where(eq(playlist.id, id));
}

/**
 * Deletes the rows of the playlists whose `.m3u` these keys were, each in its
 * library, with their entries by cascade, in one batch of statements bound
 * below D1's parameter limit: what the sweep would remove on its next pass,
 * removed now.
 */
export async function deletePlaylistRowsByKeys(
  db: Database,
  files: readonly LibraryKeys[],
): Promise<void> {
  await runBatch(
    db,
    files.flatMap(({ libraryId, keys }) =>
      chunked(keys).map((chunk) =>
        db
          .delete(playlist)
          .where(and(eq(playlist.libraryId, libraryId), inArray(playlist.r2Key, chunk))),
      ),
    ),
  );
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
  /** The library whose bucket holds the `.m3u`. */
  readonly libraryId: number;
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
 * 100,000 (#61). Reading the rows first costs one statement for all the
 * playlists a run imports, and makes the pass free.
 *
 * Only the columns the upsert would actually change are compared: the name,
 * the counts, `changed`, and the entries in order. The rest of the
 * row - the owner, the comment, the visibility and `created` - is taken
 * *from* the stored row a line above, so it cannot differ; and comparing a
 * column the upsert leaves alone would be worse than useless, since a row
 * that somehow disagreed there would be rewritten on every pass for ever
 * without the rewrite ever settling it.
 */
export function matchesStoredPlaylist(
  held: IndexedPlaylist | undefined,
  imported: ImportedPlaylist,
  { secondsOnly = false }: { readonly secondsOnly?: boolean } = {},
): boolean {
  if (held === undefined) {
    return false;
  }

  // The key and the id are not compared: the row was looked up by that key,
  // and the id is the hash of it.
  return (
    held.name === imported.name &&
    held.songCount === imported.songCount &&
    held.duration === imported.duration &&
    sameUpload(held.changedAt, imported.changedAt, secondsOnly) &&
    held.trackIds.length === imported.trackIds.length &&
    held.trackIds.every((trackId, position) => trackId === imported.trackIds[position])
  );
}

/**
 * Whether a stored `changed` is the upload time a listing now reports.
 *
 * Through the binding they are equal to the millisecond: a write stores the
 * `uploaded` its `put` answered, which every later listing reports. An S3
 * `PutObject` answers no `Last-Modified`, only its `Date`, to the second,
 * while `ListObjectsV2` reports the millisecond (storage/s3.ts). So in an S3
 * library (`secondsOnly`) a stored `changed` on a whole second also matches
 * a listed time within that second or the one before it: the `Date` of the
 * answer to the write that stored it, sent just after the object was
 * stamped. Without this, the import would rewrite once, for nothing, every
 * playlist a client wrote there (#150).
 */
function sameUpload(stored: Date, listed: Date, secondsOnly: boolean): boolean {
  const at = stored.getTime();
  if (at === listed.getTime()) {
    return true;
  }
  if (!secondsOnly || at % 1000 !== 0) {
    return false;
  }
  const second = Math.floor(listed.getTime() / 1000) * 1000;

  return second === at || second === at - 1000;
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
        libraryId: imported.libraryId,
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
        // The collision guard, as on tracks (scanner/repository.ts): another
        // library's playlist row is never moved into this one. It guards the
        // row only: the statements below still replace that id's entries.
        // So every caller makes sure first that no other library holds the
        // id: the import asks (`findPlaylistsByKeys`' `foreign`) and skips
        // such a file as broken, and a write either keeps the id of a row it
        // read with its library or makes a new key in library 1, whose id no
        // other library's can equal (playlists/writes.ts).
        setWhere: sql`${playlist.libraryId} = excluded.${sql.identifier(playlist.libraryId.name)}`,
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
  libraryId: number,
  after: string,
  through: string | null,
  listed: readonly string[],
  createdBefore: Date,
  /** Adds the rows D1 says the deletions wrote, for the daily write budget. */
  written: { rows: number } = { rows: 0 },
  tally: StatementTally = { statements: 0 },
): Promise<SweptPlaylist[]> {
  tally.statements++;
  const inRange = await db
    .select({ id: playlist.id, r2Key: playlist.r2Key })
    .from(playlist)
    .where(
      and(
        eq(playlist.libraryId, libraryId),
        gt(playlist.r2Key, after),
        through === null ? undefined : lte(playlist.r2Key, through),
        lt(playlist.createdAt, createdBefore),
      ),
    );

  const stillThere = new Set(listed);
  const gone = inRange.filter((row) => !stillThere.has(row.r2Key));

  // The entries go with them: `playlist_track` cascades on the playlist.
  // However many chunks the deletions take, they are one round trip, so a
  // stretch with many playlists gone costs the step one subrequest.
  const [first, ...rest] = chunked(gone.map((row) => row.id)).map((chunk) =>
    db.delete(playlist).where(inArray(playlist.id, chunk)),
  );
  if (first !== undefined) {
    tally.statements++;
    written.rows += rowsWrittenBy(
      rest.length === 0 ? [await first] : await db.batch([first, ...rest]),
    );
  }

  return gone;
}

/* --------------------------------------------------------------- reads -- */

/** Who may see a playlist: an admin sees all, everyone else their own and the public ones. */
export interface PlaylistViewer {
  readonly id: string;
  readonly isAdmin: boolean;
}

/**
 * A playlist as `<playlist>` needs it. `songCount` and `duration` are the
 * stored totals, whoever asks, as Navidrome's counters are (#84); the cover
 * is chosen among the entries in the caller's libraries, so it is one
 * `getCoverArt` serves them.
 */
function playlistColumns(scope: LibraryScope) {
  return {
    ...playlistRowColumns,
    // The cover of the earliest entry whose album has one. A playlist has no
    // artwork of its own here - Navidrome answers with a `pl-` id and paints a
    // mosaic of its albums, which needs an image pipeline this server does not
    // have - so it borrows a cover that `getCoverArt` can already serve, and
    // says nothing at all when no entry has one.
    coverAlbumId: sql<string | null>`(select album.id from playlist_track
    join track on track.id = playlist_track.track_id
    join album on album.id = track.album_id
    where playlist_track.playlist_id = playlist.id and album.cover_key is not null${albumInScope(scope)}
    order by playlist_track.position limit 1)`,
  };
}

/** ` and album.library_id in (...)` inside the cover subquery, or nothing on the fast path. */
function albumInScope(scope: LibraryScope) {
  const filter = libraryFilter(scope, sql.raw("album.library_id"));
  return filter === undefined ? sql`` : sql` and ${filter}`;
}

const playlistRowColumns = {
  id: playlist.id,
  name: playlist.name,
  comment: playlist.comment,
  public: playlist.public,
  songCount: playlist.songCount,
  duration: playlist.duration,
  createdAt: playlist.createdAt,
  changedAt: playlist.changedAt,
  ownerName: sql<string>`coalesce((select subsonic_user.user_name from subsonic_user
    where subsonic_user.id = playlist.owner_id), '')`,
};

/**
 * What a viewer is allowed to see, as Navidrome's `playlistRepository.
 * userFilter` decides it: everything for an admin, and otherwise the public
 * playlists and the viewer's own. Exported for the reads outside this module
 * that start from a playlist (`getSimilarSongs`), which Navidrome filters the
 * same way, through the same repository's `Get`.
 */
export function visibleTo(viewer: PlaylistViewer) {
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
 * missing from it (#9), so it is always complete. Nor is it kept to the
 * caller's libraries, as Navidrome's is not (#84); only the covers are.
 */
export async function listPlaylists(
  db: Database,
  viewer: PlaylistViewer,
  scope: LibraryScope,
): Promise<PlaylistView[]> {
  return db
    .select(playlistColumns(scope))
    .from(playlist)
    .where(visibleTo(viewer))
    .orderBy(asc(playlist.name), asc(playlist.id));
}

/**
 * Every playlist, by name then id as `listPlaylists` orders them, with its
 * owner's name: the console's overview (#82, "API: overview"), as a statement
 * for its `db.batch`.
 *
 * It is not `playlistColumns`, whose cover subquery joins `playlist_track`,
 * `track` and `album` for every playlist; the console shows no cover, so this
 * reads each playlist row and, through the primary key, its owner's, and
 * nothing else. The subquery is written out with its tables named, as
 * `artistColumns` explains: Drizzle drops the qualifier from a column of a
 * one-table query. `owner` is null for a row whose owner is no user.
 */
export function playlistSummariesQuery(db: Database) {
  return db
    .select({
      id: playlist.id,
      name: playlist.name,
      public: playlist.public,
      songCount: playlist.songCount,
      duration: playlist.duration,
      changedAt: playlist.changedAt,
      owner: sql<string | null>`(select subsonic_user.user_name from subsonic_user
        where subsonic_user.id = playlist.owner_id)`,
    })
    .from(playlist)
    .orderBy(asc(playlist.name), asc(playlist.id));
}

/**
 * One playlist, or null when there is none with this id the viewer may see;
 * its cover is in the caller's libraries, as `listPlaylists`' are.
 */
export async function findPlaylist(
  db: Database,
  viewer: PlaylistViewer,
  id: string,
  scope: LibraryScope,
): Promise<PlaylistView | null> {
  const rows = await db
    .select(playlistColumns(scope))
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
 *
 * Only the entries in the caller's libraries are listed (#84), Navidrome's
 * `tracksQuery`; `updatePlaylist` reads them all (`listPlaylistEntryTracks`).
 */
export async function listPlaylistEntries(
  db: Database,
  id: string,
  userId: string,
  scope: LibraryScope,
): Promise<SongView[]> {
  const rows = await db
    .select({ track, albumName: album.name, albumCoverKey: album.coverKey, ...annotationColumns })
    .from(playlistTrack)
    .innerJoin(track, eq(track.id, playlistTrack.trackId))
    .leftJoin(album, eq(album.id, track.albumId))
    .leftJoin(annotation, annotationJoin(userId, "track", track.id))
    .where(and(eq(playlistTrack.playlistId, id), libraryFilter(scope, track.libraryId)))
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
