/**
 * Reads of the library tables for the Lists module: the album lists a client's
 * home screens are built from, a handful of random tracks, one genre's tracks
 * by the page, an artist's most-played tracks, and what one user has starred.
 *
 * Every question is one SQL statement, as in `library/repository`, because D1
 * bills by the query. The orderings are Navidrome's, translated from its sort
 * mappings (persistence/album_repository.go `setSortMappings`) to the columns
 * Stratosonic actually stores:
 *
 * - Navidrome sorts on precomputed `order_*` columns, which hold the name
 *   lowercased and cleaned of typographic punctuation
 *   (`str.SanitizeFieldForSorting`). We have no such columns, so `lower(...)`
 *   stands in: it gets the case-insensitivity, which is the part a client
 *   notices, without a schema the scanner would have to maintain.
 * - Navidrome's mappings that mention `compilation`, `original_date` or
 *   `release_date` drop those terms here, because nothing sets them.
 * - Every ordering ends with the album's or track's id. Navidrome leaves ties
 *   to the database; an id breaks them, so paging through a list with `offset`
 *   cannot show the same album twice and skip another.
 */

import { album, annotation, artist, track } from "@stratosonic/db";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  like,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database } from "../db";
import { annotationColumns, annotationJoin } from "./annotations";
import { artistColumns, toAlbumView, toArtistView, toSongView } from "./repository";
import type { AlbumView, ArtistView, SongView } from "./serializers";

/**
 * Which albums `getAlbumList2` was asked for, and what that type needs to
 * know. Each member is one of Navidrome's `filter.Albums*` options
 * (server/filter/filters.go), including the three that read the caller's own
 * data — `recent` (last play), `frequent` (play count) and `highest` (rating).
 */
export type AlbumListQuery =
  | { readonly type: "newest" }
  | { readonly type: "alphabeticalByName" }
  | { readonly type: "alphabeticalByArtist" }
  | { readonly type: "byYear"; readonly fromYear: number; readonly toYear: number }
  | { readonly type: "byGenre"; readonly genre: string }
  | { readonly type: "random" }
  | { readonly type: "starred" }
  | { readonly type: "recent" }
  | { readonly type: "frequent" }
  | { readonly type: "highest" };

/** The window a client asked for. */
export interface Page {
  /** How many rows at most; 0 means none, and is a valid thing to ask for. */
  readonly size: number;
  readonly offset: number;
}

/**
 * The albums of one list, in that list's order.
 *
 * Without a page the whole list comes back, which is how `getStarred2` reads
 * the starred albums — it takes no `size`, and Navidrome likewise applies no
 * limit when its `QueryOptions.Max` is unset (persistence, `applyOptions`).
 */
export async function listAlbums(
  db: Database,
  userId: string,
  query: AlbumListQuery,
  page?: Page,
): Promise<AlbumView[]> {
  const statement = db
    .select({ album, ...annotationColumns })
    .from(album)
    // The caller's annotation is left-joined for the `<album>` it decorates;
    // the `starred` list narrows to the same row (albumFilter), so one join
    // serves both and no list pays a second query.
    .leftJoin(annotation, annotationJoin(userId, "album", album.id))
    .where(albumFilter(query))
    .orderBy(...albumOrder(query))
    .$dynamic();

  const rows =
    page === undefined ? await statement : await statement.limit(page.size).offset(page.offset);

  return rows.map(toAlbumView);
}

/** What narrows an album list, or nothing for the types that filter nothing. */
function albumFilter(query: AlbumListQuery): SQL | undefined {
  switch (query.type) {
    case "byGenre":
      // Navidrome matches the genre *name* with SQL `LIKE`
      // (persistence/sql_tags.go `genreFilterDef.ByName`), which makes the
      // match case-insensitive - a client that echoes back a name from
      // `getGenres` in another case still gets its albums.
      return like(album.genre, query.genre);
    case "byYear": {
      // A reversed range is a range, not an empty one: Navidrome swaps the
      // bounds and reads the reversal as "newest first" instead
      // (`filter.AlbumsByYear`), which is how a client asks for a decade
      // backwards. The ordering picks the direction up below.
      const from = Math.min(query.fromYear, query.toYear);
      const to = Math.max(query.fromYear, query.toYear);
      const inRange = and(gte(album.year, from), lte(album.year, to));

      // An album with no year is Navidrome's year *0*, not an absent value, so
      // a range that covers 0 - which `fromYear=0` is how a client spells "as
      // far back as you have" - matches it there. Ours is `NULL`, which no
      // comparison matches, so it is admitted explicitly and only then.
      return from <= 0 && to >= 0 ? or(inRange, isNull(album.year)) : inRange;
    }
    case "starred":
      // The album is starred by the caller: the left-joined annotation row
      // exists and its flag is set. This is what made the join effectively an
      // inner one before decoration moved it to a left join.
      return eq(annotation.starred, true);
    case "recent":
      // Only albums the caller has actually played, as Navidrome's `recently
      // played` filter excludes the unplayed.
      return isNotNull(annotation.playDate);
    case "frequent":
      return gt(annotation.playCount, 0);
    case "highest":
      return gt(annotation.rating, 0);
    default:
      return undefined;
  }
}

/** The order a list is read in, one `ORDER BY` per Navidrome sort mapping. */
function albumOrder(query: AlbumListQuery): SQL[] {
  switch (query.type) {
    case "newest":
      // `recently_added` descending: `album.created_at, album.id`, with
      // Navidrome's `buildSortOrder` putting `desc` on every term of a
      // descending sort.
      return [desc(album.createdAt), desc(album.id)];
    case "alphabeticalByName":
    case "byGenre":
      // Both use Navidrome's `name` mapping: `order_album_name,
      // order_album_artist_name`.
      return [byName(album.name), byName(album.albumArtist), asc(album.id)];
    case "alphabeticalByArtist":
      // Navidrome's `artist` mapping: `compilation, order_album_artist_name,
      // order_album_name`, minus the compilation flag we do not store.
      return [byName(album.albumArtist), byName(album.name), asc(album.id)];
    case "byYear":
      return query.fromYear > query.toYear
        ? [desc(album.year), desc(sql`lower(${album.name})`), desc(album.id)]
        : [asc(album.year), byName(album.name), asc(album.id)];
    case "random":
      return [sql`random()`];
    case "starred":
      // Navidrome's `starred_at` mapping is `starred, starred_at` descending;
      // the flag is constant under the filter, so only the instant is left.
      return [desc(annotation.starredAt), desc(album.id)];
    case "recent":
      // Navidrome's `recently_played`: `play_date` descending, per user.
      return [desc(annotation.playDate), desc(album.id)];
    case "frequent":
      // Navidrome's `frequently_played`: `play_count` descending.
      return [desc(annotation.playCount), desc(album.id)];
    case "highest":
      // Navidrome's `rating` mapping: `rating` descending, per user.
      return [desc(annotation.rating), desc(album.id)];
  }
}

/** One term of an alphabetical order, case-insensitive as Navidrome's are. */
function byName(column: SQL | Parameters<typeof asc>[0]): SQL {
  return asc(sql`lower(${column})`);
}

/**
 * The join condition that keeps only the rows one user has starred. It is a
 * join rather than a subquery so the `starred_at` it orders by is in scope,
 * and it names the item type because an album and a track could in principle
 * share an id.
 */
function starredBy(
  userId: string,
  itemType: "album" | "artist" | "track",
  itemId: Parameters<typeof eq>[0],
): SQL {
  return and(
    eq(annotation.userId, userId),
    eq(annotation.itemType, itemType),
    eq(annotation.itemId, itemId),
    eq(annotation.starred, true),
  ) as SQL;
}

/**
 * A track select carrying everything a `<song>` needs: the track, the two
 * things it takes from its album, and the caller's annotation.
 *
 * The album is joined left so that a track whose album row a half-finished
 * scan has not written yet is still playable - the same choice `findTrack`
 * makes - and the annotation is joined left so an item the caller has never
 * touched still comes back. Both ride in the one statement, so no list here
 * pays a second D1 query for a name, a cover or a play count.
 */
function selectTracks(db: Database, userId: string) {
  return db
    .select({ track, albumName: album.name, albumCoverKey: album.coverKey, ...annotationColumns })
    .from(track)
    .leftJoin(album, eq(album.id, track.albumId))
    .leftJoin(annotation, annotationJoin(userId, "track", track.id));
}

/** What `getRandomSongs` was asked to pick from; `null` means "do not filter". */
export interface RandomTracksQuery {
  readonly genre: string | null;
  readonly fromYear: number | null;
  readonly toYear: number | null;
  readonly size: number;
}

/**
 * A random handful of tracks, matching Navidrome's `GetRandomSongs`: the genre
 * by name, the year range inclusive on both ends, each applied only when the
 * client sent it (`filter.SongsByGenreAndYearRange`).
 */
export async function listRandomTracks(
  db: Database,
  userId: string,
  query: RandomTracksQuery,
): Promise<SongView[]> {
  const filters: SQL[] = [];

  if (query.genre !== null) {
    filters.push(like(track.genre, query.genre));
  }
  if (query.fromYear !== null) {
    filters.push(gte(track.year, query.fromYear));
  }
  if (query.toYear !== null) {
    filters.push(lte(track.year, query.toYear));
  }

  const rows = await selectTracks(db, userId)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(sql`random()`)
    .limit(query.size);

  return rows.map(toSongView);
}

/**
 * One page of a genre's tracks, for `getSongsByGenre`.
 *
 * The genre is matched with SQL `LIKE`, as `getRandomSongs?genre=` and
 * `getAlbumList2?type=byGenre` match theirs and as Navidrome matches a genre
 * name (`persistence.SongGenres.ByName`), so a client that echoes back a name
 * from `getGenres` in another case still gets its songs.
 *
 * The order is this server's, not Navidrome's. Navidrome asks for the sort
 * `name` (`filter.SongsByGenre`), which its media-file repository has no
 * mapping for, so what comes back is whatever order the database chose - fine
 * for one page, wrong for a client paging with `offset`, which would then see
 * a track twice and never see another. The title is the media-file analogue of
 * the album list's `name` ordering, lowercased for the same reason, and the id
 * breaks a tie so a page boundary falls in the same place every time.
 */
export async function listTracksOfGenre(
  db: Database,
  userId: string,
  genre: string,
  page: Page,
): Promise<SongView[]> {
  const rows = await selectTracks(db, userId)
    .where(like(track.genre, genre))
    .orderBy(byName(track.title), asc(track.id))
    .limit(page.size)
    .offset(page.offset);

  return rows.map(toSongView);
}

/**
 * An artist's own tracks, most played by the caller first, for `getTopSongs`.
 *
 * **Navidrome answers this from last.fm** — its provider looks the artist up
 * and asks an agent for that artist's top tracks (core/external, `TopSongs`).
 * Stratosonic makes no outbound calls, so it answers from the only ranking it
 * has: what this account has actually listened to. An artist nobody has played
 * still gets its tracks back, ordered by title, rather than an error — which
 * is what the endpoint is for, and an empty answer would leave an artist page
 * blank.
 *
 * The artist is matched by name with `LIKE`, as Navidrome's `findArtist`
 * matches it (`squirrel.Like{"artist.name": artistName}`), against the track's
 * album artist: the album artist is what an artist *is* here (CONTEXT.md), and
 * matching the column rather than joining the `artist` table keeps this to one
 * statement.
 *
 * The ordering is `play_count desc, rating desc, title asc, id asc`, all from
 * the caller's own annotation row. SQLite sorts nulls last under `desc`, so a
 * track the caller has never touched — no annotation row at all — sorts below
 * every track they have, without a `coalesce` that would also flatten a real
 * count of zero.
 */
export async function listTopTracks(
  db: Database,
  userId: string,
  artistName: string,
  count: number,
): Promise<SongView[]> {
  const rows = await selectTracks(db, userId)
    .where(like(track.albumArtist, artistName))
    .orderBy(
      desc(annotation.playCount),
      desc(annotation.rating),
      byName(track.title),
      asc(track.id),
    )
    .limit(count);

  return rows.map(toSongView);
}

/** Everything one user has starred, in the three kinds `<starred2>` carries. */
export interface StarredLibrary {
  readonly artists: readonly ArtistView[];
  readonly albums: readonly AlbumView[];
  readonly tracks: readonly SongView[];
}

/**
 * One user's starred artists, albums and tracks, most recently starred first.
 *
 * Three questions need three statements; they are asked together, as
 * Navidrome asks them in parallel (`getStarredItems`). Nobody else's rows can
 * come back: each statement names the user, so a library shared by two
 * accounts still gives each of them only its own list.
 */
export async function listStarred(db: Database, userId: string): Promise<StarredLibrary> {
  const [artists, albums, tracks] = await Promise.all([
    listStarredArtists(db, userId),
    listAlbums(db, userId, { type: "starred" }),
    listStarredTracks(db, userId),
  ]);

  return { artists, albums, tracks };
}

async function listStarredArtists(db: Database, userId: string): Promise<ArtistView[]> {
  const rows = await db
    .select({ ...artistColumns, ...annotationColumns })
    .from(artist)
    .innerJoin(annotation, starredBy(userId, "artist", artist.id))
    .orderBy(desc(annotation.starredAt), desc(artist.id));

  return rows.map(toArtistView);
}

async function listStarredTracks(db: Database, userId: string): Promise<SongView[]> {
  const rows = await db
    .select({ track, albumName: album.name, albumCoverKey: album.coverKey, ...annotationColumns })
    .from(track)
    .innerJoin(annotation, starredBy(userId, "track", track.id))
    .leftJoin(album, eq(album.id, track.albumId))
    .orderBy(desc(annotation.starredAt), desc(track.id));

  return rows.map(toSongView);
}
