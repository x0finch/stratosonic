import {
  album,
  DEFAULT_LIBRARY_ID,
  type Library,
  library,
  type NewLibrary,
  playlist,
  subsonicUser,
  userLibrary,
} from "@stratosonic/db";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../db";
import { resetLibraryScanStatements, writeLibraryChangedAtStatement } from "../scanner/state";

/**
 * Reads and writes of the `library` table for the console's Libraries API
 * (#84, "Libraries API"; api/libraries.ts). The scan's own reads and stamps
 * stay in scanner/, and the scope's in library/.
 *
 * Every write is guarded by the library's `state`: a library being removed
 * (`removing`) is never written again, so it can never become active again,
 * and library 1, the bound bucket, can never be marked `removing`.
 */

/** What a library holds, as the console's table shows it: its albums, summed. */
export interface LibraryCounts {
  readonly artists: number;
  readonly albums: number;
  readonly tracks: number;
  readonly sizeBytes: number;
  readonly durationSec: number;
}

/** An empty library's counts. */
export const NO_COUNTS: LibraryCounts = {
  artists: 0,
  albums: 0,
  tracks: 0,
  sizeBytes: 0,
  durationSec: 0,
};

/**
 * The album aggregates of one library, or of every library grouped by its
 * id: the albums' stored `song_count`, `size` and `duration`, which the scan
 * recomputes, as the Overview's totals read them (`library/repository.ts:
 * libraryTotalsQuery`), so neither reads a track. An artist is counted in
 * every library one of its albums is in (ADR-0009).
 */
function countsQuery(db: Database, libraryId?: number) {
  return db
    .select({
      libraryId: album.libraryId,
      artists: sql<number>`count(distinct ${album.artistId})`.mapWith(Number),
      albums: sql<number>`count(*)`.mapWith(Number),
      tracks: sql<number>`coalesce(sum(${album.songCount}), 0)`.mapWith(Number),
      sizeBytes: sql<number>`coalesce(sum(${album.size}), 0)`.mapWith(Number),
      durationSec: sql<number>`coalesce(sum(${album.duration}), 0)`.mapWith(Number),
    })
    .from(album)
    .where(libraryId === undefined ? undefined : eq(album.libraryId, libraryId))
    .groupBy(album.libraryId);
}

function countsOf(
  rows: readonly ({ libraryId: number } & LibraryCounts)[],
): Map<number, LibraryCounts> {
  return new Map(
    rows.map(({ libraryId, ...counts }) => [
      libraryId,
      { ...counts, durationSec: Math.round(counts.durationSec) },
    ]),
  );
}

/** Every library, by id, with what each holds: one batch. */
export async function listLibraries(
  db: Database,
): Promise<{ libraries: Library[]; counts: Map<number, LibraryCounts> }> {
  const [libraries, counts] = await db.batch([
    db.select().from(library).orderBy(asc(library.id)),
    countsQuery(db),
  ]);

  return { libraries, counts: countsOf(counts) };
}

/** Every library row, by id: a handful, read whole by the writes that check against the rest. */
export function readLibraries(db: Database): Promise<Library[]> {
  return db.select().from(library).orderBy(asc(library.id));
}

/** One library's row, or undefined. */
export async function findLibrary(db: Database, id: number): Promise<Library | undefined> {
  const [row] = await db.select().from(library).where(eq(library.id, id));
  return row;
}

/** Which of a new library's name and path another library already has. */
export interface Conflicts {
  readonly nameTaken: boolean;
  readonly pathTaken: boolean;
}

/**
 * Whether a library, removing ones included, already has this name (ignoring
 * case, as `library_name_unique` compares it) or this path: one statement,
 * served by the two unique indexes.
 */
export async function findConflicts(db: Database, name: string, path: string): Promise<Conflicts> {
  const rows = await db
    .select({ name: library.name, path: library.path })
    .from(library)
    .where(sql`lower(${library.name}) = lower(${name}) or ${library.path} = ${path}`);

  return {
    nameTaken: rows.some((row) => sqliteLower(row.name) === sqliteLower(name)),
    pathTaken: rows.some((row) => row.path === path),
  };
}

/** SQLite's `lower()`, which folds ASCII letters and nothing else. */
export function sqliteLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** A connected library as it is inserted: everything but the id and the scan stamps. */
export type LibraryInsert = Required<
  Pick<
    NewLibrary,
    | "name"
    | "path"
    | "endpoint"
    | "region"
    | "bucket"
    | "credentials"
    | "writable"
    | "defaultNewUsers"
  >
>;

/**
 * Inserts a connected library and gives it to every admin, in one batch
 * (#84, "Per-user access": connecting a library inserts a row per admin, as
 * Navidrome's `libraryRepository.Put` does). The new id is autoincrement, so
 * the grant finds the library by its path, which is unique. A name or path
 * another library took first throws (`libraryConflict`).
 */
export async function insertLibrary(
  db: Database,
  values: LibraryInsert,
  now: Date = new Date(),
): Promise<Library> {
  const [[inserted]] = await db.batch([
    db
      .insert(library)
      .values({ ...values, kind: "s3", state: "active", createdAt: now, updatedAt: now })
      .returning(),
    db
      .insert(userLibrary)
      .select(
        db
          .select({ userId: subsonicUser.id, libraryId: library.id })
          .from(subsonicUser)
          .innerJoin(library, eq(library.path, values.path))
          .where(eq(subsonicUser.isAdmin, true)),
      )
      .onConflictDoNothing(),
  ]);
  if (inserted === undefined) {
    throw new Error("the library insert returned no row");
  }

  return inserted;
}

/**
 * Which unique index refused a library write, if one did: the name, ignoring
 * case, or the path. D1 reports the SQLite error in the message, which
 * Drizzle may wrap, so the causes are searched too, as
 * `isUserNameConflict` (users/repository.ts) does.
 */
export function libraryConflict(error: unknown): "name" | "path" | null {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if (!cause.message.includes("UNIQUE constraint failed")) {
      continue;
    }
    if (cause.message.includes("library_name_unique")) {
      return "name";
    }
    if (cause.message.includes("library.path") || cause.message.includes("library_path_unique")) {
      return "path";
    }
  }

  return null;
}

/** What a `PATCH` changes on a library row. */
export type LibraryChanges = Partial<
  Pick<
    NewLibrary,
    "name" | "defaultNewUsers" | "path" | "endpoint" | "bucket" | "credentials" | "writable"
  >
>;

/**
 * Changes an active library, in one batch, and answers it as written with its
 * counts, or null when it is no longer active (it is being removed). With
 * `resetScan`, the batch also starts the library's scan over: its cursor, if
 * the pass is in it, and its memo of broken objects
 * (`resetLibraryScanStatements`), as a change of bucket requires (#84,
 * "Scanning several libraries"). A name or path another library has throws
 * (`libraryConflict`).
 */
export async function updateLibrary(
  db: Database,
  id: number,
  changes: LibraryChanges,
  resetScan: boolean,
  now: Date = new Date(),
): Promise<{ library: Library; counts: LibraryCounts } | null> {
  const update = db
    .update(library)
    .set({ ...changes, updatedAt: now })
    .where(and(eq(library.id, id), eq(library.state, "active")))
    .returning();
  // The reset runs only when the update did: a library being removed keeps
  // what its cleanup reads.
  const applied = sql`exists (select 1 from ${library} where ${library.id} = ${id}
    and ${library.state} = 'active' and ${library.updatedAt} = ${now.getTime()})`;
  const reset = resetScan ? resetLibraryScanStatements(db, id, applied) : [];

  const [updated, counts] = await db.batch([update, countsQuery(db, id), ...reset]);
  const row = updated[0];
  if (row === undefined) {
    return null;
  }

  return { library: row, counts: countsOf(counts).get(id) ?? NO_COUNTS };
}

/**
 * Stamps what a connection test found on an active library: whether it may
 * be written to, and why it failed (null when it did not). A failed test
 * leaves `writable` as the last good one found it.
 */
export async function recordConnectionTest(
  db: Database,
  id: number,
  result: { readonly writable?: boolean; readonly error: string | null },
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(library)
    .set({
      ...(result.writable === undefined ? {} : { writable: result.writable }),
      lastScanError: result.error,
      updatedAt: now,
    })
    .where(and(eq(library.id, id), eq(library.state, "active")));
}

/** What a removal request found, and did. */
export type RemovalOutcome =
  | { readonly removed: { tracks: number; albums: number; playlists: number } }
  | { readonly refused: "not_found" | "default_library" | "removing" };

/**
 * The request half of a removal (#84, "Removing a library", step 1), in one
 * batch, which D1 runs as one transaction:
 *
 * 1. what the library holds, read before anything is written: its albums
 *    and their tracks (the albums' `song_count`, as the console's table
 *    counts them), and its playlists;
 * 2. `state = 'removing'`, only on an active library other than library 1,
 *    stamped `now`. From here no scope contains it, for an admin too;
 * 3. its `user_library` rows;
 * 4. the rows of the playlists whose file is in it (ADR-0006: a row goes when
 *    its file is unreachable), their entries by cascade;
 * 5. the change, as `LibraryChangedAt`.
 *
 * Steps 3 to 5 run only when step 2 wrote (the library is `removing`, stamped
 * `now`), so a refused request writes nothing. The rest, its tracks, albums
 * and their annotations, is the scan's cleanup phase (scanner/cleanup.ts).
 */
export async function markLibraryRemoving(
  db: Database,
  id: number,
  now: Date = new Date(),
): Promise<RemovalOutcome> {
  const applied = sql`exists (select 1 from ${library} where ${library.id} = ${id}
    and ${library.state} = 'removing' and ${library.updatedAt} = ${now.getTime()})`;

  const [found, marked] = await db.batch([
    db
      .select({
        state: library.state,
        albums:
          sql<number>`(select count(*) from ${album} where ${album.libraryId} = ${id})`.mapWith(
            Number,
          ),
        tracks: sql<number>`(select coalesce(sum(${album.songCount}), 0) from ${album}
          where ${album.libraryId} = ${id})`.mapWith(Number),
        playlists: sql<number>`(select count(*) from ${playlist}
          where ${playlist.libraryId} = ${id})`.mapWith(Number),
      })
      .from(library)
      .where(eq(library.id, id)),
    db
      .update(library)
      .set({ state: "removing", updatedAt: now })
      .where(
        and(eq(library.id, id), eq(library.state, "active"), ne(library.id, DEFAULT_LIBRARY_ID)),
      )
      .returning({ id: library.id }),
    db.delete(userLibrary).where(and(eq(userLibrary.libraryId, id), applied)),
    db.delete(playlist).where(and(eq(playlist.libraryId, id), applied)),
    writeLibraryChangedAtStatement(db, now.getTime(), applied),
  ]);

  const row = found[0];
  if (row === undefined) {
    return { refused: "not_found" };
  }
  if (marked.length === 0) {
    return { refused: id === DEFAULT_LIBRARY_ID ? "default_library" : "removing" };
  }

  return { removed: { tracks: row.tracks, albums: row.albums, playlists: row.playlists } };
}
