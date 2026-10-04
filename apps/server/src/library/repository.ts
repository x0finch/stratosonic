/**
 * Reads of the library tables, for the endpoints that browse them.
 *
 * Every function here answers one endpoint's question in one SQL statement,
 * because D1 bills by the query and the free tier's budget is per request.
 * Where a count has to be exact — an artist's `albumCount` — it is an
 * aggregate in that same statement rather than a second round trip, as
 * Navidrome computes it at query time too. What an album already stores (its
 * song count, duration and size, recomputed by the scan) is read, not counted
 * again.
 *
 * Ids taken by these functions are bare, as they are stored; parsing the
 * prefix off a client's id belongs to the endpoint.
 *
 * Every read that serves a caller takes the libraries it may see, a
 * `LibraryScope` (library/scope.ts), beside its user: an album or a track
 * outside it is not there, and an artist is there while one of its albums
 * is. On the fast path the scope adds nothing, and the SQL is v0.5.0's.
 */

import { type Album, album, annotation, artist, library, type Track, track } from "@stratosonic/db";
import { and, asc, desc, eq, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import type { Database } from "../db";
import { chunked, KEYS_PER_STATEMENT } from "../scanner/repository";
import { type StorageRow, storageRowColumns } from "../storage/track-storage";
import {
  type AnnotationRow,
  annotationColumns,
  annotationJoin,
  toCallerAnnotation,
} from "./annotations";
import {
  albumOfArtistInScope,
  artistInScope,
  type LibraryScope,
  libraryFilter,
  scopeParameters,
} from "./scope";
import type { AlbumView, ArtistView, GenreView, SongView } from "./serializers";

/**
 * The albums of an artist in the order `getArtist` lists them: Navidrome
 * sorts them by year and then by name (`filter.AlbumsByArtistID`, whose
 * `max_year` mapping falls through to the album name), and the id breaks a
 * tie so two albums that agree on both keep a stable order. SQLite sorts a
 * null year first, where Navidrome's year of 0 also sorts.
 */
const ALBUMS_OF_ARTIST_ORDER = [asc(album.year), asc(album.name), asc(album.id)];

/**
 * An artist with the two things that are not columns: how many albums it has,
 * and which of them lends it a cover.
 *
 * **The cover album is the first album with a cover in the order `getArtist`
 * lists them** — by year, then name, then id. "First" has to be defined
 * because nothing about an artist says which of its covers should stand for
 * it; this rule makes it the earliest release with artwork, and makes the
 * answer stable across requests and rescans.
 *
 * Both subqueries are written out rather than composed from the schema
 * objects: Drizzle drops the table qualifier from a column when the query it
 * builds names one table, and an unqualified `id` inside these subqueries
 * would bind to the album's own id instead of the artist's — a correlation
 * that silently matches nothing.
 *
 * **Both count only the albums in scope** (#84): an artist shared by two
 * libraries has, for a caller who sees one, that library's albums and a
 * cover from among them.
 */
export function artistColumns(scope: LibraryScope) {
  return {
    id: artist.id,
    name: artist.name,
    albumCount: sql<number>`(select count(*) from album where album.artist_id = artist.id${albumOfArtistInScope(scope)})`,
    coverAlbumId: coverAlbumOf(scope),
  };
}

/** The artist's cover album among the albums in scope (`artistColumns`). */
export function coverAlbumOf(scope: LibraryScope) {
  return sql<string | null>`(select album.id from album
    where album.artist_id = artist.id and album.cover_key is not null${albumOfArtistInScope(scope)}
    order by album.year, album.name, album.id limit 1)`;
}

/**
 * An artist select with the caller's annotation left-joined, for the reads
 * that list or find artists. Sharing it keeps the join — and so the `starred`
 * and `userRating` an `<artist>` carries — identical wherever an artist is
 * read (browsing, the folder index, starred, search).
 *
 * The select is filtered here, to `filter` and the scope's artists, so no
 * caller can leave the scope out; callers order and page it.
 */
export function selectArtists(db: Database, userId: string, scope: LibraryScope, filter?: SQL) {
  return db
    .select({ ...artistColumns(scope), ...annotationColumns })
    .from(artist)
    .leftJoin(annotation, annotationJoin(userId, "artist", artist.id))
    .where(and(filter, artistInScope(scope)));
}

/** An artist row from `selectArtists`, as the `<artist>` element needs it. */
export function toArtistView(row: ArtistColumns & AnnotationRow): ArtistView {
  return {
    id: row.id,
    name: row.name,
    albumCount: row.albumCount,
    coverAlbumId: row.coverAlbumId,
    annotation: toCallerAnnotation(row),
  };
}

type ArtistColumns = {
  readonly id: string;
  readonly name: string;
  readonly albumCount: number;
  readonly coverAlbumId: string | null;
};

/**
 * An album select with the caller's annotation left-joined. `getAlbumList2`
 * builds its own decorated select (it needs the annotation for its ordering
 * too), but every place that reads a plain album goes through this one.
 * It is filtered to `filter` and the scope's libraries, as `selectArtists`
 * is.
 */
export function selectAlbums(db: Database, userId: string, scope: LibraryScope, filter?: SQL) {
  return db
    .select({ album, ...annotationColumns })
    .from(album)
    .leftJoin(annotation, annotationJoin(userId, "album", album.id))
    .where(and(filter, libraryFilter(scope, album.libraryId)));
}

/** An album row from `selectAlbums`, as the `<album>` elements need it. */
export function toAlbumView(row: { album: Album } & AnnotationRow): AlbumView {
  return { ...row.album, annotation: toCallerAnnotation(row) };
}

/** A track row with its album's name and cover, as `<song>` needs it. */
export function toSongView(
  row: { track: Track; albumName: string | null; albumCoverKey: string | null } & AnnotationRow,
): SongView {
  return {
    ...row.track,
    albumName: row.albumName,
    albumCoverKey: row.albumCoverKey,
    annotation: toCallerAnnotation(row),
  };
}

/**
 * Every artist in scope, for `getArtists` and `getIndexes` to bucket into
 * indexes. A shared artist is one row, whatever libraries its albums are in.
 */
export async function listArtists(
  db: Database,
  userId: string,
  scope: LibraryScope,
): Promise<ArtistView[]> {
  const rows = await selectArtists(db, userId, scope).orderBy(asc(artist.name));

  return rows.map(toArtistView);
}

/**
 * One artist, or null when no artist has this id, or none of its albums is
 * in scope. The user is required: a read that serves a caller decorates the
 * artist with that caller's annotation, and an internal read that only needs
 * the row (cover resolution) says so by passing `NO_USER`.
 */
export async function findArtist(
  db: Database,
  id: string,
  userId: string,
  scope: LibraryScope,
): Promise<ArtistView | null> {
  const rows = await selectArtists(db, userId, scope, eq(artist.id, id)).limit(1);

  return rows[0] ? toArtistView(rows[0]) : null;
}

/** An artist's albums in scope, in the order `getArtist` lists them. */
export async function listAlbumsOfArtist(
  db: Database,
  artistId: string,
  userId: string,
  scope: LibraryScope,
): Promise<AlbumView[]> {
  const rows = await selectAlbums(db, userId, scope, eq(album.artistId, artistId)).orderBy(
    ...ALBUMS_OF_ARTIST_ORDER,
  );

  return rows.map(toAlbumView);
}

/**
 * One album, or null when no album has this id or it is out of scope;
 * `NO_USER` reads it plain.
 */
export async function findAlbum(
  db: Database,
  id: string,
  userId: string,
  scope: LibraryScope,
): Promise<AlbumView | null> {
  const rows = await selectAlbums(db, userId, scope, eq(album.id, id)).limit(1);

  return rows[0] ? toAlbumView(rows[0]) : null;
}

/**
 * An album's tracks, by disc and then track number — the order a record plays
 * in, which is what Navidrome's `SongsByAlbum` sort comes down to within one
 * album: `disc_number, track_number, order_artist_name, title`
 * (persistence/mediafile_repository.go). The artist, the title and then the
 * id break a tie, so an album whose tags carry no track numbers still has one
 * order rather than whatever the database happens to return.
 *
 * The album is passed rather than looked up: the endpoint has already read it,
 * and its name and cover are what each `<song>` needs from it. Its tracks are
 * in its library, so the scope only restates what reading the album checked.
 */
export async function listTracksOfAlbum(
  db: Database,
  of: Album,
  userId: string,
  scope: LibraryScope,
): Promise<SongView[]> {
  const rows = await db
    .select({ track, ...annotationColumns })
    .from(track)
    .leftJoin(annotation, annotationJoin(userId, "track", track.id))
    .where(and(eq(track.albumId, of.id), libraryFilter(scope, track.libraryId)))
    .orderBy(
      asc(track.discNumber),
      asc(track.trackNumber),
      asc(track.artist),
      asc(track.title),
      asc(track.id),
    );

  return rows.map((row) => toSongView({ ...row, albumName: of.name, albumCoverKey: of.coverKey }));
}

/** What `findTrack` selects: the track, its album's name and cover, and the annotation. */
const trackColumns = {
  track,
  albumName: album.name,
  albumCoverKey: album.coverKey,
  ...annotationColumns,
};

/** The track with this id, if it is in scope. */
function trackInScope(id: string, scope: LibraryScope): SQL | undefined {
  return and(eq(track.id, id), libraryFilter(scope, track.libraryId));
}

/**
 * One track with its album's name and cover, or null when no track has this
 * id. The album is joined in rather than fetched after, so `getSong` is one
 * query; the join is left, so a track whose album row is missing — a state a
 * half-finished scan can leave behind — is still served, without a cover.
 * A track out of scope is not found.
 */
export async function findTrack(
  db: Database,
  id: string,
  userId: string,
  scope: LibraryScope,
): Promise<SongView | null> {
  const rows = await db
    .select(trackColumns)
    .from(track)
    .leftJoin(album, eq(album.id, track.albumId))
    .leftJoin(annotation, annotationJoin(userId, "track", track.id))
    .where(trackInScope(id, scope))
    .limit(1);

  return rows[0] ? toSongView(rows[0]) : null;
}

/** A track to serve the bytes of, and its library's row when it was joined. */
export interface TrackToServe {
  readonly song: SongView;
  /** Null when the lookup did not join it (`joinsLibraryRow`). */
  readonly library: StorageRow | null;
}

/**
 * `findTrack` for the reads that serve the track's bytes (`stream`,
 * `download`): with `joinLibrary`, its library's row is joined in the same
 * statement, inner, since a track whose library is gone has no bucket to be
 * read from. Without it the statement is `findTrack`'s exactly (#84, "storage
 * per track's library"; storage/track-storage.ts).
 */
export async function findTrackToServe(
  db: Database,
  id: string,
  userId: string,
  scope: LibraryScope,
  joinLibrary: boolean,
): Promise<TrackToServe | null> {
  if (!joinLibrary) {
    const song = await findTrack(db, id, userId, scope);
    return song === null ? null : { song, library: null };
  }

  const rows = await db
    .select({ ...trackColumns, library: storageRowColumns })
    .from(track)
    .leftJoin(album, eq(album.id, track.albumId))
    .leftJoin(annotation, annotationJoin(userId, "track", track.id))
    .innerJoin(library, eq(library.id, track.libraryId))
    .where(trackInScope(id, scope))
    .limit(1);

  const row = rows[0];
  return row ? { song: toSongView(row), library: row.library } : null;
}

/**
 * Every genre a track carries, with the songs and the albums it covers.
 *
 * Both counts come from the tracks, in one grouped query: a genre has as many
 * albums as there are distinct albums among its tracks, which is the relation
 * Navidrome keeps in its `album_genres` table and fills from the same tags.
 * The order is Navidrome's — most songs first, then most albums, then the name
 * (`GetGenres` asks for `song_count, album_count, name desc` descending, which
 * its sort builder turns into descending counts and an ascending name).
 *
 * Only the tracks in scope count, so a genre none of them carries is not
 * listed. Navidrome filters its `library_tag` counts the same way; the
 * tracks are what those counts are made from here.
 */
export async function listGenres(db: Database, scope: LibraryScope): Promise<GenreView[]> {
  return toGenreViews(await genresQuery(db, scope));
}

/**
 * `listGenres`' statement, unrun, for a caller that sends it in a `db.batch`
 * with others (the console's overview, api/overview.ts); `toGenreViews` reads
 * what it returns.
 */
export function genresQuery(db: Database, scope: LibraryScope) {
  const songCount = sql<number>`count(*)`;
  const albumCount = sql<number>`count(distinct ${track.albumId})`;

  return db
    .select({ name: track.genre, songCount, albumCount })
    .from(track)
    .where(and(isNotNull(track.genre), libraryFilter(scope, track.libraryId)))
    .groupBy(track.genre)
    .orderBy(desc(songCount), desc(albumCount), asc(track.genre));
}

/** The rows `genresQuery` returns, as `listGenres` answers them. */
export function toGenreViews(rows: Awaited<ReturnType<typeof genresQuery>>): GenreView[] {
  return rows.map((row) => ({ ...row, name: genreName(row.name) }));
}

/**
 * The library's size, for the console's overview (#82, "API: overview"), as
 * a statement for its `db.batch`: how many artists and albums there are, and
 * the tracks, seconds and bytes the albums add up to.
 *
 * The three sums read what each album stores - its `song_count`, `duration`
 * and `size`, which the scan recomputes (scanner/repository.ts) - so the
 * statement reads the album rows and none of the far more numerous tracks.
 * `coalesce` makes an empty library zeros rather than nulls.
 *
 * For some libraries (the console's library filter, #84) the albums are
 * theirs, and the artists are counted from those albums, since an artist is
 * shared and is in a library through its albums (ADR-0009). For every
 * library the artist table is counted, as v0.5.0 counted it.
 */
export function libraryTotalsQuery(db: Database, scope: LibraryScope) {
  return db
    .select({
      artists: scope.all
        ? sql<number>`(select count(*) from artist)`
        : sql<number>`count(distinct ${album.artistId})`,
      albums: sql<number>`count(*)`,
      tracks: sql<number>`coalesce(sum(${album.songCount}), 0)`,
      duration: sql<number>`coalesce(sum(${album.duration}), 0)`,
      size: sql<number>`coalesce(sum(${album.size}), 0)`,
    })
    .from(album)
    .where(libraryFilter(scope, album.libraryId));
}

/**
 * Navidrome renames a genre with an empty name to `<Empty>` before answering
 * (`GetGenres`), so a client has something to show and something to ask for.
 * A track with no genre tag at all carries null and is not a genre here, as it
 * is not one there.
 */
function genreName(name: string | null): string {
  return name === null || name === "" ? "<Empty>" : name;
}

/**
 * The songs these ids name, by id — for the reads that hold a list of track
 * ids rather than a query that selects them, the play queue being the first.
 *
 * An id that names no track is simply absent from the map: a queue saved
 * before a rescan removed one of its tracks still resumes, minus that entry,
 * rather than failing. Duplicates cost nothing, since the caller looks each
 * position up by id.
 *
 * This is one `in (...)` per `KEYS_PER_STATEMENT` ids, less what the scope
 * binds — D1 allows a hundred bound parameters per query
 * (`scanner/repository.ts`) — and not one query per id, so even a very long
 * queue stays well inside the request's subrequest budget. Order is the
 * caller's to restore; SQL gives none back.
 *
 * A track out of scope is absent too (#84), as `getPlayQueue` leaves out a
 * track that has gone.
 */
export async function findSongsByIds(
  db: Database,
  ids: readonly string[],
  userId: string,
  scope: LibraryScope,
): Promise<Map<string, SongView>> {
  const found = new Map<string, SongView>();

  for (const chunk of chunked([...new Set(ids)], KEYS_PER_STATEMENT - scopeParameters(scope))) {
    const rows = await db
      .select(trackColumns)
      .from(track)
      .leftJoin(album, eq(album.id, track.albumId))
      .leftJoin(annotation, annotationJoin(userId, "track", track.id))
      .where(and(inArray(track.id, chunk), libraryFilter(scope, track.libraryId)));

    for (const row of rows) {
      found.set(row.track.id, toSongView(row));
    }
  }

  return found;
}
