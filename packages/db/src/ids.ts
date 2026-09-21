/**
 * Entity ids, following Navidrome's `model/id` package: 16 bytes rendered as a
 * zero-padded 22-character base62 string.
 *
 * Users get a *random* id (`newRandomId`, Navidrome's `id.NewRandom`). Library
 * entities get a *content-derived* one (`newHashId`, Navidrome's `id.NewHash`),
 * so a rescan of an unchanged library mints the same ids it did last time
 * (ADR-0002).
 *
 * Ids are stored bare and travel to clients with a type prefix - `ar-`, `al-`,
 * `tr-`, `pl-` - which is added and stripped here.
 */

import { md5 } from "./md5";

/** Digits in the order Go's `big.Int.Text(62)` emits them. */
const BASE62_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** 16 bytes of base62 never need more than this many digits. */
export const ID_LENGTH = 22;

/** A fresh random id, as Navidrome mints for users. */
export function newRandomId(): string {
  return encodeId(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Renders 16 bytes as the canonical id. The value is read as one big-endian
 * unsigned integer and printed in base62, left-padded with the base62 zero
 * digit so every id is the same width.
 */
export function encodeId(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new Error(`an id is made of 16 bytes, got ${bytes.length}`);
  }

  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  let digits = "";
  while (value > 0n) {
    digits = BASE62_DIGITS[Number(value % 62n)] + digits;
    value /= 62n;
  }

  return digits.padStart(ID_LENGTH, BASE62_DIGITS[0]);
}

/**
 * Navidrome's `NewHash` writes a zero-width space after *each* part - not
 * between them - so a one-part hash ends with a separator too. Keeping that
 * detail keeps `newHashId("a", "b")` distinct from `newHashId("ab")`.
 */
const HASH_SEPARATOR = "\u200b";

const UTF8 = new TextEncoder();

/**
 * The id of whatever these parts describe: `base62(md5(...))`, byte for byte
 * Navidrome's `id.NewHash`.
 *
 * Parts are taken as given. Callers that hash a *name* normalize it first with
 * `normalizeIdPart`; callers that hash an R2 key do not, because the key is
 * already the exact identity of the object.
 */
export function newHashId(...parts: readonly string[]): string {
  return encodeId(md5(UTF8.encode(parts.map((part) => part + HASH_SEPARATOR).join(""))));
}

/**
 * Characters that occupy no space and therefore cannot distinguish two names a
 * person would read as the same: zero-width spaces and joiners, the bidi marks,
 * embeddings and isolates, the byte-order mark, and the soft hyphen. The
 * zero-width space is also `newHashId`'s separator, so leaving it in a value
 * would let a tag reach across parts.
 */
const INVISIBLE_CHARACTERS =
  /[\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

/**
 * Typographic punctuation that means the same as an ASCII character. The map is
 * Navidrome's `str.Clear` (`utils/str/str.go`), which folds these *to* ASCII
 * rather than dropping them: "Weird Al" keeps its quotes, and only the shape of
 * them stops mattering.
 *
 * Each class is an explicit list, never a range: Navidrome names exactly these
 * characters, and a range here would quietly fold hundreds of unrelated ones -
 * an ellipsis or an arrow becoming a hyphen is a collision between two albums
 * that are not the same album.
 */
const TYPOGRAPHIC_CHARACTERS: readonly (readonly [RegExp, string])[] = [
  [/[\u2018\u2019\u201b\u2032]/g, "'"],
  [/[\uff02\u3003\u02ee\u05f2\u1cd3\u2033\u2036\u02f6\u02ba\u201c\u201d\u02dd\u201f]/g, '"'],
  [/[\u2010\u2013\u2014\u2212\u2015]/g, "-"],
];

/**
 * A name as it goes into an id: same case, same punctuation, no invisible
 * characters, no surrounding space. Two spellings that differ only in those
 * ways name the same artist or album, and so must hash the same - otherwise
 * retagging one track of an album splits it in two.
 */
export function normalizeIdPart(value: string): string {
  let normalized = value.toLowerCase().replace(INVISIBLE_CHARACTERS, "");

  for (const [pattern, replacement] of TYPOGRAPHIC_CHARACTERS) {
    normalized = normalized.replace(pattern, replacement);
  }

  return normalized.trim();
}

/** A track is identified by where it lives: its R2 key, exactly as stored. */
export function trackId(r2Key: string): string {
  return newHashId(r2Key);
}

/**
 * An album is identified by its album artist, its name and its year, so two
 * albums of the same name by different artists - or two editions from
 * different years - stay apart. A missing year hashes as the empty string.
 */
export function albumId(
  albumArtist: string,
  albumName: string,
  year?: number | null | undefined,
): string {
  return newHashId(
    normalizeIdPart(albumArtist),
    normalizeIdPart(albumName),
    year == null ? "" : String(year),
  );
}

/** An artist is identified by its name alone. */
export function artistId(name: string): string {
  return newHashId(normalizeIdPart(name));
}

/**
 * A playlist is identified by the R2 key of the `.m3u` it was imported from,
 * so editing the file re-imports into the same playlist and renaming it makes
 * a new one.
 */
export function playlistId(m3uR2Key: string): string {
  return newHashId(m3uR2Key);
}

/** The kinds of entity a client-facing id can name. */
export const ENTITY_TYPES = ["artist", "album", "track", "playlist"] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

/** The prefix each kind wears on the wire. */
export const ENTITY_ID_PREFIXES: Readonly<Record<EntityType, string>> = {
  artist: "ar-",
  album: "al-",
  track: "tr-",
  playlist: "pl-",
};

/** An id as it is stored, paired with what it names. */
export interface EntityId {
  readonly type: EntityType;
  readonly id: string;
}

const BASE62_ID = /^[0-9a-zA-Z]{22}$/;

/** Every id renders 16 bytes, so this is one more than the largest of them. */
const ID_LIMIT = 1n << 128n;

/**
 * Whether the text is an id this server could have minted: 22 base62 digits
 * that fit in 16 bytes. The length alone is not enough - "zzzz..." is 22 base62
 * digits and a number no 16-byte value reaches - and Navidrome's `id.Decode`
 * rejects it for the same reason.
 */
function isCanonicalId(id: string): boolean {
  if (!BASE62_ID.test(id)) {
    return false;
  }

  let value = 0n;
  for (const digit of id) {
    value = value * 62n + BigInt(BASE62_DIGITS.indexOf(digit));
  }

  return value < ID_LIMIT;
}

/** A stored id as a client sees it, e.g. `al-3Zo4...`. */
export function prefixedId(type: EntityType, id: string): string {
  return ENTITY_ID_PREFIXES[type] + id;
}

/**
 * Reads an id a client sent back. Anything that is not a known prefix followed
 * by a canonical 22-character base62 id is `null` - the caller answers such an
 * id with "not found" rather than searching for it, because it can name
 * nothing we ever minted.
 */
export function parsePrefixedId(value: string): EntityId | null {
  for (const type of ENTITY_TYPES) {
    const prefix = ENTITY_ID_PREFIXES[type];
    if (!value.startsWith(prefix)) {
      continue;
    }

    const id = value.slice(prefix.length);
    return isCanonicalId(id) ? { type, id } : null;
  }

  return null;
}

/** The stored id `value` names, if it names one of this type; `null` if not. */
export function parseIdOfType(type: EntityType, value: string): string | null {
  const parsed = parsePrefixedId(value);

  return parsed?.type === type ? parsed.id : null;
}
