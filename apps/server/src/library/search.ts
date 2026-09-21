/**
 * The read behind the Search module: matching artists, albums and tracks by
 * name for `search2` and `search3`.
 *
 * Navidrome answers these from a maintained `full_text` column and an FTS
 * index; Stratosonic matches with SQL `LIKE '%word%'` over the name/title
 * columns instead, because the library is personal-scale (~1000 tracks) and a
 * `full_text` column would be new state the scanner has to compute and keep
 * current for no user-visible gain at this size (ADR/issue #37). The behaviour
 * a client notices is preserved:
 *
 * - **Case-insensitive substring.** SQLite's `LIKE` folds ASCII case, so
 *   "beat" finds "The Beatles" and "Heartbeat"; a CJK query has no case to
 *   fold and matches as a plain substring.
 * - **Every word must match (AND).** A query is split on whitespace and each
 *   word is required, as Navidrome's full-text filter requires each term, so
 *   "beatles help" finds the one track and not every Beatles song. A word may
 *   match any of the columns a kind carries (OR within the word).
 * - **An empty query matches everything**, paged — some clients enumerate the
 *   whole library that way, which Navidrome also allows.
 *
 * Each kind is ordered by its name and then its id, so paging one kind with
 * `offset` never repeats a row or skips one — the same stability the album
 * lists get from ending every ordering on the id.
 */

import { type Album, album, artist, track } from "@stratosonic/db";
import { and, asc, eq, or, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { Database } from "../db";
import { artistColumns } from "./repository";
import type { ArtistView, SongView } from "./serializers";

/** One kind's slice of a search: how many rows, and where to start. */
export interface SearchWindow {
  readonly count: number;
  readonly offset: number;
}

/** What a search was asked for: the words to match, and each kind's window. */
export interface SearchQuery {
  /** The query split on whitespace; empty matches the whole library. */
  readonly words: readonly string[];
  readonly artists: SearchWindow;
  readonly albums: SearchWindow;
  readonly songs: SearchWindow;
}

/** What a search found, in the three kinds the result containers carry. */
export interface SearchResults {
  readonly artists: readonly ArtistView[];
  readonly albums: readonly Album[];
  readonly tracks: readonly SongView[];
}

/**
 * Runs the three kinds of a search together, as Navidrome runs them in
 * parallel, and skips the query for a kind the client asked none of (`count`
 * of 0), so a client that wants only songs pays for only that read.
 */
export async function searchLibrary(db: Database, query: SearchQuery): Promise<SearchResults> {
  const [artists, albums, tracks] = await Promise.all([
    searchArtists(db, query.words, query.artists),
    searchAlbums(db, query.words, query.albums),
    searchTracks(db, query.words, query.songs),
  ]);

  return { artists, albums, tracks };
}

/** Artists whose name matches every word, by name then id. */
async function searchArtists(
  db: Database,
  words: readonly string[],
  window: SearchWindow,
): Promise<ArtistView[]> {
  if (window.count <= 0) {
    return [];
  }

  return db
    .select(artistColumns)
    .from(artist)
    .where(matchesEveryWord([artist.name], words))
    .orderBy(byName(artist.name), asc(artist.id))
    .limit(window.count)
    .offset(window.offset);
}

/**
 * Albums whose name or album artist matches every word, by name, album artist,
 * then id. The album artist is matched because Navidrome's `full_text` for an
 * album is built from its name *and* its artist, so "beatles help" finds the
 * album Help! there and has to find it here too.
 */
async function searchAlbums(
  db: Database,
  words: readonly string[],
  window: SearchWindow,
): Promise<Album[]> {
  if (window.count <= 0) {
    return [];
  }

  return db
    .select()
    .from(album)
    .where(matchesEveryWord([album.name, album.albumArtist], words))
    .orderBy(byName(album.name), byName(album.albumArtist), asc(album.id))
    .limit(window.count)
    .offset(window.offset);
}

/**
 * Tracks whose title, album name, own artist or album artist matches every
 * word, by title then id — the same four fields Navidrome's `full_text` for a
 * media file is built from. The album is left-joined for the name a word may
 * match and the name and cover every `<song>` carries, so a track whose album
 * row a half-finished scan has not written yet is still found — the same
 * choice `findTrack` makes.
 */
async function searchTracks(
  db: Database,
  words: readonly string[],
  window: SearchWindow,
): Promise<SongView[]> {
  if (window.count <= 0) {
    return [];
  }

  const rows = await db
    .select({ track, albumName: album.name, albumCoverKey: album.coverKey })
    .from(track)
    .leftJoin(album, eq(album.id, track.albumId))
    .where(matchesEveryWord([track.title, album.name, track.artist, track.albumArtist], words))
    .orderBy(byName(track.title), asc(track.id))
    .limit(window.count)
    .offset(window.offset);

  return rows.map((row) => ({
    ...row.track,
    albumName: row.albumName,
    albumCoverKey: row.albumCoverKey,
  }));
}

/**
 * The filter that keeps rows matching every word, or nothing at all for an
 * empty query — an absent `WHERE`, which is how "match everything" is spelled.
 * Each word may match any of the columns (OR); all words are required (AND).
 */
function matchesEveryWord(
  columns: readonly SQLWrapper[],
  words: readonly string[],
): SQL | undefined {
  if (words.length === 0) {
    return undefined;
  }

  return and(...words.map((word) => matchesWord(columns, word)));
}

/** One word against a kind's columns: it may match any of them. */
function matchesWord(columns: readonly SQLWrapper[], word: string): SQL {
  const pattern = `%${escapeLike(word)}%`;

  return or(
    ...columns.map((column) => sql`${column} like ${pattern} escape ${LIKE_ESCAPE}`),
  ) as SQL;
}

/** The character that turns a `LIKE` wildcard into a literal. */
const LIKE_ESCAPE = "\\";

/**
 * Escapes a word for `LIKE`, so a query that contains `%` or `_` — a client
 * searching for "50%" — matches those characters literally rather than as
 * wildcards. The escape character escapes itself first, before it is used to
 * escape the others.
 */
function escapeLike(word: string): string {
  return word.replace(/[\\%_]/g, (character) => LIKE_ESCAPE + character);
}

/** One term of an alphabetical order, case-insensitive as the library's are. */
function byName(column: SQLWrapper): SQL {
  return asc(sql`lower(${column})`);
}
