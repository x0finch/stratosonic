/**
 * The read behind the Search module: matching artists, albums and tracks by
 * name for `search2` and `search3`.
 *
 * Navidrome sends a query holding Han, kana or hangul to `likeSearchExpr`
 * (persistence/sql_search_like.go): split with `strings.Fields`, each word a
 * `LIKE '%word%'` ORed across title, album, artist and album artist. Any other
 * query goes to an FTS5 index (unicode61 tokenizer), which matches word
 * prefixes and folds case by Unicode rules; its legacy backend matched a
 * `full_text` column with `LIKE '% term%'`. Stratosonic runs substring `LIKE`
 * over the name/title columns for every query, so it matches Navidrome's CJK
 * path exactly and differs from its FTS5 path in finding mid-word substrings
 * and folding only ASCII case. No index is kept because the library is
 * personal-scale (~1000 tracks) and one would be new state the scanner has to
 * compute and keep current for no user-visible gain at this size (ADR/issue
 * #37). The behaviour a client notices is preserved:
 *
 * - **Case-insensitive substring.** SQLite's `LIKE` folds ASCII case, so
 *   "beat" finds "The Beatles" and "Heartbeat"; a CJK query has no case to
 *   fold and matches as a plain substring.
 * - **Every word must match (AND).** A query is split on whitespace and each
 *   word is required, as Navidrome's full-text filter requires each term, so
 *   "beatles help" finds the one track and not every Beatles song. A word may
 *   match any of the columns a kind carries (OR within the word).
 * - **CJK matches as an exact run of characters.** `LIKE` compares code
 *   points, so any contiguous substring of a Chinese, Japanese or Korean name
 *   finds it ("父之" finds 以父之名, "ヒカ" 宇多田ヒカル, "이유" 아이유), and
 *   a CJK word ANDs with an ASCII one like any other ("晨光 live"). There is
 *   no tokenisation beyond the whitespace split: CJK is written unspaced, so
 *   an unspaced CJK query is one word and must occur whole — "以名" does not
 *   find 以父之名, "以 名" does. The split is on JavaScript's `\s`, which
 *   includes the ideographic space U+3000 an input method types. The tests
 *   in test/search-cjk.test.ts pin each of these (#73).
 * - **An empty query matches everything**, paged — some clients enumerate the
 *   whole library that way, per the Phase 2 spec (#37); Navidrome treats an
 *   empty query as missing.
 *
 * One deviation is known and accepted: **folding stops at ASCII.** Navidrome
 * builds `full_text` through its own sanitiser, which lowercases by Unicode
 * rules and strips accents, so "bjork" finds Björk and "ÉCOUTE" finds écoute
 * there. SQLite's `LIKE` folds the ASCII letters only and folds no accent, so
 * here a query has to carry the accents and the case of a non-ASCII letter as
 * the tag spells them. Nor is anything Unicode-normalised (no NFKC):
 * full-width Latin is not its ASCII form — "First" does not find
 * "Ｆｉｒｓｔ Ｌｏｖｅ", "ＹＯＡＳＯＢＩ" does not find YOASOBI, and
 * full-width letters fold no case — and half-width katakana is not full-width
 * katakana. Closing that gap means storing a folded column — the
 * state #37 decided against — so it waits for a library that needs it.
 *
 * Each kind is ordered by its name and then its id, so paging one kind with
 * `offset` never repeats a row or skips one — the same stability the album
 * lists get from ending every ordering on the id.
 *
 * Every kind is kept to the caller's `LibraryScope` (library/scope.ts),
 * narrowed by any `musicFolderId`, as Navidrome's searches apply its library
 * filter. The scope's ids are bound parameters, so they are charged to a
 * statement's budget before its words are (`wordsThatFit`).
 */

import { album, annotation, artist, track } from "@stratosonic/db";
import { and, asc, eq, or, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { D1_MAX_BOUND_PARAMETERS } from "../d1-limits";
import type { Database } from "../db";
import { annotationColumns, annotationJoin } from "./annotations";
import { selectAlbums, selectArtists, toAlbumView, toArtistView, toSongView } from "./repository";
import { type LibraryScope, libraryFilter, scopeParameters } from "./scope";
import type { AlbumView, ArtistView, SongView } from "./serializers";

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
  readonly albums: readonly AlbumView[];
  readonly tracks: readonly SongView[];
}

/**
 * Runs the three kinds of a search together, as Navidrome runs them in
 * parallel, and skips the query for a kind the client asked none of (`count`
 * of 0), so a client that wants only songs pays for only that read.
 *
 * Each hit carries the caller's annotation, joined in the same statement
 * (library/annotations.ts), so a starred or rated result shows it as it does
 * everywhere else.
 */
export async function searchLibrary(
  db: Database,
  query: SearchQuery,
  userId: string,
  scope: LibraryScope,
): Promise<SearchResults> {
  const [artists, albums, tracks] = await Promise.all([
    searchArtists(db, query.words, query.artists, userId, scope),
    searchAlbums(db, query.words, query.albums, userId, scope),
    searchTracks(db, query.words, query.songs, userId, scope),
  ]);

  return { artists, albums, tracks };
}

/**
 * Artists whose name matches every word, by name then id. The scope is bound
 * three times: in the artist's membership, its `albumCount` and its cover
 * (`artistColumns`).
 */
async function searchArtists(
  db: Database,
  words: readonly string[],
  window: SearchWindow,
  userId: string,
  scope: LibraryScope,
): Promise<ArtistView[]> {
  if (window.count <= 0) {
    return [];
  }

  const filter = matchesEveryWord([artist.name], words, 3 * scopeParameters(scope));
  const rows = await selectArtists(db, userId, scope, filter)
    .orderBy(byName(artist.name), asc(artist.id))
    .limit(window.count)
    .offset(window.offset);

  return rows.map(toArtistView);
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
  userId: string,
  scope: LibraryScope,
): Promise<AlbumView[]> {
  if (window.count <= 0) {
    return [];
  }

  const filter = matchesEveryWord([album.name, album.albumArtist], words, scopeParameters(scope));
  const rows = await selectAlbums(db, userId, scope, filter)
    .orderBy(byName(album.name), byName(album.albumArtist), asc(album.id))
    .limit(window.count)
    .offset(window.offset);

  return rows.map(toAlbumView);
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
  userId: string,
  scope: LibraryScope,
): Promise<SongView[]> {
  if (window.count <= 0) {
    return [];
  }

  const rows = await db
    .select({ track, albumName: album.name, albumCoverKey: album.coverKey, ...annotationColumns })
    .from(track)
    .leftJoin(album, eq(album.id, track.albumId))
    .leftJoin(annotation, annotationJoin(userId, "track", track.id))
    .where(
      and(
        matchesEveryWord(
          [track.title, album.name, track.artist, track.albumArtist],
          words,
          scopeParameters(scope),
        ),
        libraryFilter(scope, track.libraryId),
      ),
    )
    .orderBy(byName(track.title), asc(track.id))
    .limit(window.count)
    .offset(window.offset);

  return rows.map(toSongView);
}

/**
 * The filter that keeps rows matching every word, or nothing at all for an
 * empty query — an absent `WHERE`, which is how "match everything" is spelled.
 * Each word may match any of the columns (OR); all words are required (AND).
 *
 * A query longer than the statement can bind loses its surplus words rather
 * than failing: see `wordsThatFit`. `scoped` is what the statement's scope
 * binds.
 */
function matchesEveryWord(
  columns: readonly SQLWrapper[],
  words: readonly string[],
  scoped: number,
): SQL | undefined {
  const matched = wordsThatFit(columns, words, scoped);

  if (matched.length === 0) {
    return undefined;
  }

  return and(...matched.map((word) => matchesWord(columns, word)));
}

/**
 * As many leading words as the statement may bind, which for a long query is
 * fewer than were typed.
 *
 * Every word binds one parameter per column, and the rest of the statement
 * binds `FIXED_BOUND_PARAMETERS` more, plus `scoped` for the caller's
 * libraries (at most `MAX_LISTED_LIBRARIES` per use of the scope,
 * library/scope.ts), so the track query — four columns — could otherwise
 * exceed D1's hundred at twenty-five words and fail the whole read, on a
 * statement Miniflare's SQLite runs happily. Dropping the surplus words only
 * widens what matches, which is a better answer to a client that pasted a
 * paragraph into its search box than an error is. Navidrome, with one bound
 * `full_text` pattern per term, has no such ceiling.
 */
function wordsThatFit(
  columns: readonly SQLWrapper[],
  words: readonly string[],
  scoped: number,
): readonly string[] {
  const budget = D1_MAX_BOUND_PARAMETERS - FIXED_BOUND_PARAMETERS - scoped;

  return words.slice(0, Math.floor(budget / columns.length));
}

/**
 * What every search statement binds besides its words: the window's `limit`
 * and `offset`, and the two the caller's annotation join fixes — the user id
 * and the item type (`annotationJoin`; the item id is a column, not a
 * parameter). Every kind of search joins that annotation in, so the four are
 * charged to all of them.
 */
const FIXED_BOUND_PARAMETERS = 4;

/**
 * One word against a kind's columns: it may match any of them.
 *
 * Only the pattern is bound. The escape character is written into the SQL
 * instead, because a second parameter per column would halve how many words a
 * query may carry (`wordsThatFit`) for a character that never varies.
 */
function matchesWord(columns: readonly SQLWrapper[], word: string): SQL {
  const pattern = `%${escapeLike(word)}%`;

  return or(
    ...columns.map((column) => sql`${column} like ${pattern} ${LIKE_ESCAPE_CLAUSE}`),
  ) as SQL;
}

/** The character that turns a `LIKE` wildcard into a literal. */
const LIKE_ESCAPE = "\\";

/** That character as literal SQL, so naming it costs no bound parameter. */
const LIKE_ESCAPE_CLAUSE = sql.raw(`escape '${LIKE_ESCAPE}'`);

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
