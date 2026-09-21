/**
 * How artists are bucketed into the `<index>` groups `getArtists` and
 * `getIndexes` answer with, following Navidrome.
 *
 * Navidrome does this in two halves: the scanner stores an `order_artist_name`
 * for every artist — `str.SanitizeFieldForSortingNoArticle`, which folds
 * accents, drops a leading article, lowercases and folds typographic
 * punctuation (utils/str/sanitize_strings.go) — and the artist repository
 * groups by the first character of that name against the configured index
 * groups, falling back to `#` (persistence/artist_repository.go,
 * `getIndexKey`). Stratosonic stores no such column, so the same name is
 * derived here, where it is used.
 */

import { normalizeIdPart } from "@stratosonic/db";

/**
 * Navidrome's default `IgnoredArticles`, emitted verbatim as the
 * `ignoredArticles` attribute and used to strip a leading article before
 * bucketing (conf/configuration.go).
 */
export const IGNORED_ARTICLES = "The El La Los Las Le Les Os As O A";

/**
 * Navidrome's default `IndexGroups`. Each entry is a bucket; an entry of the
 * form `Label(chars)` is one bucket reached by any of those characters, which
 * is how X, Y and Z share a bucket (conf/configuration.go).
 */
const INDEX_GROUPS = "A B C D E F G H I J K L M N O P Q R S T U V W X-Z(XYZ) [Unknown]([)";

/** The bucket everything no group claims falls into, as the spec requires. */
const FALLBACK_INDEX = "#";

const GROUP_WITH_CHARACTERS = /^(.+)\((.+)\)$/;

/**
 * Reads an index-group specification into the prefixes that reach each bucket,
 * as Navidrome's `utils.ParseIndexGroups` does.
 */
export function parseIndexGroups(spec: string): Map<string, string> {
  const groups = new Map<string, string>();

  for (const entry of spec.split(" ")) {
    const [, label, characters] = GROUP_WITH_CHARACTERS.exec(entry) ?? [];

    if (label !== undefined && characters !== undefined) {
      for (const character of characters) {
        groups.set(character.toLowerCase(), label);
      }
    } else if (entry !== "") {
      groups.set(entry.toLowerCase(), entry);
    }
  }

  return groups;
}

/**
 * The prefixes that reach a bucket, longest first. Navidrome walks a Go map,
 * whose order is random; with the default groups every prefix is one character
 * so no name can match two of them. Ordering by length keeps that arbitrary
 * choice deterministic — and makes the longest prefix win — for a
 * specification that does name a multi-character group.
 */
const INDEX_PREFIXES = [...parseIndexGroups(INDEX_GROUPS)].sort(
  ([left], [right]) => right.length - left.length,
);

/** The articles a name is bucketed and sorted without. */
const ARTICLES = IGNORED_ARTICLES.split(" ").filter((article) => article !== "");

/**
 * Folds accented letters onto the ASCII letter they are written with, so
 * "Éire" buckets under E rather than under `#`. Navidrome uses a
 * transliteration table (`sanitize.Accents`); decomposing and dropping the
 * combining marks covers the same letters, short of the few that carry their
 * stroke inside the code point (Ø, Ł) and stay as they are.
 */
function foldAccents(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/**
 * Drops one leading article. Navidrome compares the articles against the name
 * before it is lowercased (`RemoveArticle`), so "The Band" loses its article
 * and "the band" keeps it; the case is kept to match.
 */
function removeArticle(name: string): string {
  for (const article of ARTICLES) {
    if (name.startsWith(`${article} `)) {
      return name.slice(article.length + 1);
    }
  }

  return name;
}

/**
 * The name an artist sorts and buckets under: Navidrome's
 * `order_artist_name`. `normalizeIdPart` is the lowercase-and-fold half of it
 * (Navidrome's `str.Clear`, shared with the id derivation).
 */
export function indexOrderName(name: string): string {
  return normalizeIdPart(removeArticle(foldAccents(name).trim()).trim());
}

/** The index bucket an artist of this name belongs in. */
export function indexKeyOf(name: string): string {
  const orderName = indexOrderName(name);

  for (const [prefix, group] of INDEX_PREFIXES) {
    if (orderName.startsWith(prefix)) {
      return group;
    }
  }

  return FALLBACK_INDEX;
}

/** One `<index>`: its label and the artists that fell into it. */
export interface ArtistIndex<T> {
  readonly name: string;
  readonly artists: readonly T[];
}

/**
 * Groups artists into their index buckets, buckets ordered by name and artists
 * within a bucket by the name they sort under — Navidrome sorts the indexes
 * with `cmp.Compare` on the label and the artists by `order_artist_name`, both
 * byte-wise, which is what comparing the strings here does.
 */
export function groupArtistsByIndex<T>(
  artists: readonly T[],
  nameOf: (artist: T) => string,
): ArtistIndex<T>[] {
  const buckets = new Map<string, T[]>();

  for (const artist of [...artists].sort(byOrderName(nameOf))) {
    const key = indexKeyOf(nameOf(artist));
    const bucket = buckets.get(key);

    if (bucket) {
      bucket.push(artist);
    } else {
      buckets.set(key, [artist]);
    }
  }

  return [...buckets]
    .sort(([left], [right]) => compare(left, right))
    .map(([name, artists]) => ({ name, artists }));
}

function byOrderName<T>(nameOf: (artist: T) => string): (left: T, right: T) => number {
  return (left, right) => compare(indexOrderName(nameOf(left)), indexOrderName(nameOf(right)));
}

/** Byte-wise, as SQLite's default collation and Go's `cmp.Compare` both are. */
function compare(left: string, right: string): number {
  if (left === right) return 0;

  return left < right ? -1 : 1;
}
