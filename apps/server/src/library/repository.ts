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

import { type Album, album, artist, track } from "@stratosonic/db";
import { asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db";
import type { ArtistView, GenreView, SongView } from "./serializers";

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
const artistColumns = {
  id: artist.id,
  name: artist.name,
  albumCount: sql<number>`(select count(*) from album where album.artist_id = artist.id)`,
  coverAlbumId: sql<string | null>`(select album.id from album
    where album.artist_id = artist.id and album.cover_key is not null
    order by album.year, album.name, album.id limit 1)`,
};

/** Every artist, for `getArtists` to bucket into indexes. */
export async function listArtists(db: Database): Promise<ArtistView[]> {
  return db.select(artistColumns).from(artist).orderBy(asc(artist.name));
}

/** One artist, or null when no artist has this id. */
export async function findArtist(db: Database, id: string): Promise<ArtistView | null> {
  const rows = await db.select(artistColumns).from(artist).where(eq(artist.id, id)).limit(1);

  return rows[0] ?? null;
}

/** An artist's albums, in the order `getArtist` lists them. */
export async function listAlbumsOfArtist(db: Database, artistId: string): Promise<Album[]> {
  return db
    .select()
    .from(album)
    .where(eq(album.artistId, artistId))
    .orderBy(...ALBUMS_OF_ARTIST_ORDER);
}

/** One album, or null when no album has this id. */
export async function findAlbum(db: Database, id: string): Promise<Album | null> {
  const rows = await db.select().from(album).where(eq(album.id, id)).limit(1);

  return rows[0] ?? null;
}

/**
 * An album's tracks, by disc and then track number — the order a record plays
 * in, which is what Navidrome's `SongsByAlbum` sort comes down to within one
 * album (`disc_number, track_number, title`). The title, and then the id,
 * break a tie so an album whose tags carry no track numbers still has one
 * order rather than whatever the database happens to return.
 *
 * The album is passed rather than looked up: the endpoint has already read it,
 * and its name and cover are what each `<song>` needs from it.
 */
export async function listTracksOfAlbum(db: Database, of: Album): Promise<SongView[]> {
  const rows = await db
    .select()
    .from(track)
    .where(eq(track.albumId, of.id))
    .orderBy(asc(track.discNumber), asc(track.trackNumber), asc(track.title), asc(track.id));

  return rows.map((row) => ({ ...row, albumName: of.name, albumCoverKey: of.coverKey }));
}

/**
 * One track with its album's name and cover, or null when no track has this
 * id. The album is joined in rather than fetched after, so `getSong` is one
 * query; the join is left, so a track whose album row is missing — a state a
 * half-finished scan can leave behind — is still served, without a cover.
 */
export async function findTrack(db: Database, id: string): Promise<SongView | null> {
  const rows = await db
    .select({ track, albumName: album.name, albumCoverKey: album.coverKey })
    .from(track)
    .leftJoin(album, eq(album.id, track.albumId))
    .where(eq(track.id, id))
    .limit(1);

  const row = rows[0];

  return row ? { ...row.track, albumName: row.albumName, albumCoverKey: row.albumCoverKey } : null;
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
