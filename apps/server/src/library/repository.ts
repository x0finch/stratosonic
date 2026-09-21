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
 */

import { type Album, album, annotation, artist, type Track, track } from "@stratosonic/db";
import { asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db";
import { chunked } from "../scanner/repository";
import {
  type AnnotationRow,
  annotationColumns,
  annotationJoin,
  toCallerAnnotation,
} from "./annotations";
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
 */
export const artistColumns = {
  id: artist.id,
  name: artist.name,
  albumCount: sql<number>`(select count(*) from album where album.artist_id = artist.id)`,
  coverAlbumId: sql<string | null>`(select album.id from album
    where album.artist_id = artist.id and album.cover_key is not null
    order by album.year, album.name, album.id limit 1)`,
};

/**
 * An artist select with the caller's annotation left-joined, for the reads
 * that list or find artists. Sharing it keeps the join — and so the `starred`
 * and `userRating` an `<artist>` carries — identical wherever an artist is
 * read (browsing, the folder index, starred, search).
 */
export function selectArtists(db: Database, userId: string) {
  return db
    .select({ ...artistColumns, ...annotationColumns })
    .from(artist)
    .leftJoin(annotation, annotationJoin(userId, "artist", artist.id));
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
 */
export function selectAlbums(db: Database, userId: string) {
  return db
    .select({ album, ...annotationColumns })
    .from(album)
    .leftJoin(annotation, annotationJoin(userId, "album", album.id));
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

/** Every artist, for `getArtists` to bucket into indexes. */
export async function listArtists(db: Database, userId: string): Promise<ArtistView[]> {
  const rows = await selectArtists(db, userId).orderBy(asc(artist.name));

  return rows.map(toArtistView);
}

/**
 * One artist, or null when no artist has this id. `userId` defaults to none,
 * for the internal reads that only need the row (cover resolution): an empty
 * user matches no annotation, so the artist comes back undecorated.
 */
export async function findArtist(
  db: Database,
  id: string,
  userId = "",
): Promise<ArtistView | null> {
  const rows = await selectArtists(db, userId).where(eq(artist.id, id)).limit(1);

  return rows[0] ? toArtistView(rows[0]) : null;
}

/** An artist's albums, in the order `getArtist` lists them. */
export async function listAlbumsOfArtist(
  db: Database,
  artistId: string,
  userId: string,
): Promise<AlbumView[]> {
  const rows = await selectAlbums(db, userId)
    .where(eq(album.artistId, artistId))
    .orderBy(...ALBUMS_OF_ARTIST_ORDER);

  return rows.map(toAlbumView);
}

/** One album, or null when no album has this id. `userId` defaults to none. */
export async function findAlbum(db: Database, id: string, userId = ""): Promise<AlbumView | null> {
  const rows = await selectAlbums(db, userId).where(eq(album.id, id)).limit(1);

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
 * and its name and cover are what each `<song>` needs from it.
 */
export async function listTracksOfAlbum(
  db: Database,
  of: Album,
  userId: string,
): Promise<SongView[]> {
  const rows = await db
    .select({ track, ...annotationColumns })
    .from(track)
    .leftJoin(annotation, annotationJoin(userId, "track", track.id))
    .where(eq(track.albumId, of.id))
    .orderBy(
      asc(track.discNumber),
      asc(track.trackNumber),
      asc(track.artist),
      asc(track.title),
      asc(track.id),
    );

  return rows.map((row) => toSongView({ ...row, albumName: of.name, albumCoverKey: of.coverKey }));
}

/**
 * One track with its album's name and cover, or null when no track has this
 * id. The album is joined in rather than fetched after, so `getSong` is one
 * query; the join is left, so a track whose album row is missing — a state a
 * half-finished scan can leave behind — is still served, without a cover.
 */
export async function findTrack(db: Database, id: string, userId = ""): Promise<SongView | null> {
  const rows = await db
    .select({ track, albumName: album.name, albumCoverKey: album.coverKey, ...annotationColumns })
    .from(track)
    .leftJoin(album, eq(album.id, track.albumId))
    .leftJoin(annotation, annotationJoin(userId, "track", track.id))
    .where(eq(track.id, id))
    .limit(1);

  return rows[0] ? toSongView(rows[0]) : null;
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
 */
export async function listGenres(db: Database): Promise<GenreView[]> {
  const songCount = sql<number>`count(*)`;
  const albumCount = sql<number>`count(distinct ${track.albumId})`;

  const rows = await db
    .select({ name: track.genre, songCount, albumCount })
    .from(track)
    .where(isNotNull(track.genre))
    .groupBy(track.genre)
    .orderBy(desc(songCount), desc(albumCount), asc(track.genre));

  return rows.map((row) => ({ ...row, name: genreName(row.name) }));
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
 * This is one `in (...)` per `KEYS_PER_STATEMENT` ids — D1 allows a hundred
 * bound parameters per query (`scanner/repository.ts`) — and not one query per
 * id, so even a very long queue stays well inside the request's subrequest
 * budget. Order is the caller's to restore; SQL gives none back.
 */
export async function findSongsByIds(
  db: Database,
  ids: readonly string[],
  userId: string,
): Promise<Map<string, SongView>> {
  const found = new Map<string, SongView>();

  for (const chunk of chunked([...new Set(ids)])) {
    const rows = await db
      .select({ track, albumName: album.name, albumCoverKey: album.coverKey, ...annotationColumns })
      .from(track)
      .leftJoin(album, eq(album.id, track.albumId))
      .leftJoin(annotation, annotationJoin(userId, "track", track.id))
      .where(inArray(track.id, chunk));

    for (const row of rows) {
      found.set(row.track.id, toSongView(row));
    }
  }

  return found;
}
