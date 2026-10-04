/**
 * The rules for the keys the console's Files page reads and writes (#83,
 * "Keys and the allow-list"): which keys a new upload may take, what kind of
 * file each suffix is, and which prefixes are the scanner's own. The routes
 * (api/files.ts) and the tests both use this module, and nothing else
 * restates a rule.
 *
 * ## Existing keys are never rewritten
 *
 * The scanner takes keys verbatim, and a track's id is the hash of its key's
 * exact string (ADR-0002). So a key browse lists, or delete is given, is used
 * exactly as it stands: only a **new** key is normalised, to Unicode NFC, as
 * R2 itself treats NFC-equivalent keys as one object ("Unicode
 * interoperability"). An invalid key is refused, never cleaned.
 *
 * ## The allow-list is the scanner's
 *
 * An upload is accepted only if the server reads its kind of file, and each
 * kind's suffixes come from the module that reads it: the scan's audio
 * formats, the lyrics sidecars, the playlist import's suffixes and the cover
 * images' extensions (plus `jpeg`, the other common spelling of `jpg`). A
 * format the scanner learns becomes uploadable with no change here.
 */

import { DEFAULT_LIBRARY_ID } from "@stratosonic/db";
import { AUDIO_CONTENT_TYPES, AUDIO_SUFFIXES, suffixOf } from "../library/audio-formats";
import { MAX_SIDECAR_BYTES, SIDECAR_SUFFIXES } from "../lyrics/sidecar";
import { PLAYLIST_SUFFIXES } from "../playlists/m3u";
import { COVER_PREFIX, IMAGE_SUFFIXES } from "../scanner/covers";

/** R2's longest key, in bytes of UTF-8 (R2 limits). */
export const MAX_KEY_BYTES = 1024;

/**
 * The longest segment of a new key, in bytes of UTF-8: the file-name limit of
 * the file systems rclone copies the bucket back to, so the bucket stays a
 * tree that can be mirrored.
 */
export const MAX_SEGMENT_BYTES = 255;

/**
 * The scanner's own prefix, where it writes the covers it extracts: hidden
 * from browse and refused to every write, since deleting a cover there leaves
 * an album pointing at nothing until its track's bytes change.
 */
export const RESERVED_PREFIX = COVER_PREFIX;

/**
 * The prefixes reserved in the bound bucket, library 1: `_covers/`, where
 * the scan writes every library's covers (#84, "Covers"). It is the default
 * of every rule below that takes reserved prefixes, so a caller that names
 * no library gets library 1's rules.
 */
export const BOUND_RESERVED_PREFIXES: readonly string[] = [RESERVED_PREFIX];

/** A connected library's reserved prefixes: none, since no cover is written to its bucket. */
const NO_RESERVED_PREFIXES: readonly string[] = [];

/**
 * The prefixes a library reserves: `_covers/` in library 1 only (#84,
 * "Covers"). A connected library's bucket holds the owner's files and
 * nothing of the scanner's, so all of it can be browsed and written.
 */
export function reservedPrefixesOf(libraryId: number): readonly string[] {
  return libraryId === DEFAULT_LIBRARY_ID ? BOUND_RESERVED_PREFIXES : NO_RESERVED_PREFIXES;
}

/** The kinds of file the server reads, and so the kinds an upload may be. */
export type FileKind = "audio" | "lyrics" | "playlist" | "image";

/** A listed object's kind: one the server reads, or `other` (a `.cue`, a `.log`). */
export type ListedKind = FileKind | "other";

/** What one kind accepts. */
export interface KindRule {
  /** Lower-case, without the dot. */
  readonly suffixes: readonly string[];
  /** The largest upload of this kind, in bytes. */
  readonly maxBytes: number;
}

/** R2's largest single `PUT`: 5 GiB − 5 MiB (R2 limits). */
const MAX_SINGLE_PUT_BYTES = 5 * 1024 ** 3 - 5 * 1024 ** 2;

/** About 20,000 entries: no playlist a listener keeps is bigger. */
const MAX_PLAYLIST_BYTES = 4 * 1024 ** 2;

/** Far above any cover or booklet scan. */
const MAX_IMAGE_BYTES = 20 * 1024 ** 2;

/** The allow-list, kind by kind, in the order the console shows it. */
export const ALLOWED: Readonly<Record<FileKind, KindRule>> = {
  audio: { suffixes: AUDIO_SUFFIXES, maxBytes: MAX_SINGLE_PUT_BYTES },
  lyrics: {
    suffixes: SIDECAR_SUFFIXES.map((suffix) => suffix.replace(/^\./, "")),
    // A larger sidecar is ignored by the reader, so refusing it saves a
    // useless upload.
    maxBytes: MAX_SIDECAR_BYTES,
  },
  playlist: { suffixes: PLAYLIST_SUFFIXES, maxBytes: MAX_PLAYLIST_BYTES },
  image: { suffixes: [...new Set([...IMAGE_SUFFIXES, "jpeg"])], maxBytes: MAX_IMAGE_BYTES },
};

const KINDS = Object.keys(ALLOWED) as readonly FileKind[];

/** The kind a suffix (lower-case, without the dot) belongs to, or null. */
export function kindOfSuffix(suffix: string): FileKind | null {
  return KINDS.find((kind) => ALLOWED[kind].suffixes.includes(suffix)) ?? null;
}

/**
 * The kind of a listed object, by its suffix, case ignored (`suffixOf`):
 * `other` for anything the server does not read.
 */
export function kindOf(key: string): ListedKind {
  return kindOfSuffix(suffixOf(key)) ?? "other";
}

/**
 * The content type an upload of this kind and suffix is stored with. It comes
 * from the suffix, never from the browser's `File.type`, which varies
 * (`audio/x-flac`, `audio/flac`, or nothing).
 *
 * - audio: the scanner's own (Navidrome's MIME types);
 * - lyrics: `text/plain`;
 * - playlist: `audio/x-mpegurl` for `.m3u` (Navidrome's `mime_types.yaml`)
 *   and `application/vnd.apple.mpegurl` for `.m3u8`, its IANA type;
 * - image: `image/<suffix>`, with `jpg` and `jpeg` both `image/jpeg`.
 */
export function contentTypeOf(kind: FileKind, suffix: string): string {
  switch (kind) {
    case "audio":
      return AUDIO_CONTENT_TYPES[suffix as keyof typeof AUDIO_CONTENT_TYPES];
    case "lyrics":
      return "text/plain";
    case "playlist":
      return suffix === "m3u8" ? "application/vnd.apple.mpegurl" : "audio/x-mpegurl";
    case "image":
      return suffix === "jpg" || suffix === "jpeg" ? "image/jpeg" : `image/${suffix}`;
  }
}

/** Why a key or prefix is refused, as the API names it. */
export type PathRefusal = "invalid_path" | "path_too_long" | "reserved_path" | "type_not_allowed";

/** A new key that passed every rule. */
export interface UploadKey {
  /** The key, in NFC. */
  readonly key: string;
  readonly kind: FileKind;
  readonly suffix: string;
  readonly contentType: string;
}

/** The length of a string in bytes of UTF-8, as R2 counts a key. */
export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** U+0000–U+001F, U+007F, and the backslash a Windows path drops in. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
const FORBIDDEN_CHARACTERS = /[\u0000-\u001f\u007f\\]/;

/**
 * Whether one segment of a new key is acceptable: not empty, no control
 * character or backslash, and not starting with a dot, which also refuses `.`
 * and `..`. Navidrome skips hidden files (its playlist phase's rule), and the
 * dot keeps `.DS_Store` and `._*` out.
 */
function isAcceptableSegment(segment: string): boolean {
  return segment !== "" && !segment.startsWith(".") && !FORBIDDEN_CHARACTERS.test(segment);
}

/**
 * Checks a key a new upload would take, after normalising it to NFC, and
 * answers it with its kind and content type, or why it is refused. With a
 * folder `prefix` (as a listing gave it, `checkUploadPrefix`), the key must
 * start with it, and only the part after it is normalised: the folder keeps
 * the spelling it is stored under, so an upload into a folder stored in NFD
 * (named on macOS) lands in that folder, not in an NFC twin of it.
 *
 * - `invalid_path`: outside `prefix`;
 * - `invalid_path`: not well-formed UTF-16 (a lone surrogate, which no
 *   UTF-8 key can hold and which no URL can encode), empty, absolute (a
 *   leading `/`), a folder (a trailing `/`), an empty segment (`a//b`), a
 *   `.` or `..` segment, a segment that starts with a dot, a control
 *   character or a backslash;
 * - `path_too_long`: over `MAX_KEY_BYTES`, or a segment over
 *   `MAX_SEGMENT_BYTES`, in bytes of UTF-8;
 * - `reserved_path`: under one of `reserved`, the library's reserved
 *   prefixes (`reservedPrefixesOf`), library 1's unless given;
 * - `type_not_allowed`: a suffix outside the allow-list.
 */
export function checkUploadKey(
  raw: string,
  prefix = "",
  reserved: readonly string[] = BOUND_RESERVED_PREFIXES,
): UploadKey | { readonly error: PathRefusal } {
  if (!isWellFormed(raw) || !raw.startsWith(prefix)) {
    return { error: "invalid_path" };
  }
  const key = newKeySpelling(raw, prefix);
  const segments = key.split("/");
  if (!segments.every(isAcceptableSegment)) {
    return { error: "invalid_path" };
  }
  if (
    utf8Length(key) > MAX_KEY_BYTES ||
    segments.some((segment) => utf8Length(segment) > MAX_SEGMENT_BYTES)
  ) {
    return { error: "path_too_long" };
  }
  if (isReservedKey(key, reserved)) {
    return { error: "reserved_path" };
  }

  const suffix = suffixOf(key);
  const kind = kindOfSuffix(suffix);
  if (kind === null) {
    return { error: "type_not_allowed" };
  }

  return { key, kind, suffix, contentType: contentTypeOf(kind, suffix) };
}

/**
 * The spelling a new key takes: in NFC after `prefix`, which it keeps as it
 * is. A key outside `prefix` is normalised whole.
 */
export function newKeySpelling(raw: string, prefix = ""): string {
  return raw.startsWith(prefix)
    ? prefix + raw.slice(prefix.length).normalize("NFC")
    : raw.normalize("NFC");
}

/**
 * Checks the folder prefix an upload request names, as a listing gave it:
 * as browse takes a prefix (`""` for the root, or ending in `/`, at most
 * `MAX_KEY_BYTES`, not under one of `reserved`), and well-formed. It is
 * never normalised.
 */
export function checkUploadPrefix(
  prefix: string,
  reserved: readonly string[] = BOUND_RESERVED_PREFIXES,
): "invalid_path" | "reserved_path" | null {
  return isWellFormed(prefix) ? checkBrowsePrefix(prefix, reserved) : "invalid_path";
}

/**
 * Whether a string is well-formed UTF-16: no lone surrogate.
 * `String.prototype.isWellFormed` (ES2024) is in workerd and Node 22, but
 * not in this project's ES2022 lib, hence the cast.
 */
function isWellFormed(value: string): boolean {
  return (value as string & { isWellFormed(): boolean }).isWellFormed();
}

/*
 * Spellings. R2 treats Unicode-equivalent keys as one object, but lists the
 * spelling last uploaded, and a track's id is the hash of that exact string
 * (ADR-0002). So a Replace must write under the stored spelling, segment by
 * segment, which the route finds by listing (api/files.ts). These say which
 * part of a segment, asked for in NFC, every stored spelling of it shares.
 *
 * A character outside ASCII can be stored composed, decomposed, or (for a
 * CJK compatibility ideograph, say) as another code point altogether. So can
 * three ASCII characters, each the canonical decomposition of a code point
 * of its own: `K` (KELVIN SIGN), `;` (GREEK QUESTION MARK) and `` ` ``
 * (GREEK VARIA); test/files-keys.test.ts checks that there are no others.
 * Every other ASCII character has one spelling: it is in NFC and NFD alike,
 * and no other code point normalises to it. An ASCII character in an NFC
 * segment is also never the base of a following combining mark, which NFC
 * would have composed with it, unless no composed form exists, in which case
 * every spelling keeps the base too.
 */

/** The ASCII characters some other code point canonically decomposes to. */
const ASCII_WITH_SINGLETONS = /[K;`]/;

/** A string of ASCII only, which NFC leaves as it is. */
export function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * Whether a segment, in NFC, has one spelling only: ASCII, and none of the
 * three ASCII characters another code point decomposes to.
 */
export function hasOneSpelling(segment: string): boolean {
  return isAscii(segment) && !ASCII_WITH_SINGLETONS.test(segment);
}

/**
 * The leading part of a segment, in NFC, that every stored spelling of it
 * starts with: the characters before its first one that can be spelled
 * another way (`hasOneSpelling`). It may be empty (`Édith Piaf`).
 */
export function oneSpellingPrefix(segment: string): string {
  let length = 0;
  while (length < segment.length && hasOneSpelling(segment.charAt(length))) {
    length++;
  }

  return segment.slice(0, length);
}

/** Why an upload's size is refused, or null when its kind takes it. */
export function checkUploadSize(kind: FileKind, size: number): "empty_file" | "too_large" | null {
  if (size === 0) {
    // No readable audio, lyrics, playlist or image is empty.
    return "empty_file";
  }

  return size > ALLOWED[kind].maxBytes ? "too_large" : null;
}

/**
 * Whether a key, listed or new, is under one of a library's reserved
 * prefixes: library 1's, the scanner's `_covers/`, unless `reserved` is
 * given.
 */
export function isReservedKey(
  key: string,
  reserved: readonly string[] = BOUND_RESERVED_PREFIXES,
): boolean {
  return reserved.some((prefix) => key.startsWith(prefix));
}

/**
 * Checks a folder's prefix as browse takes it (`GET /api/files?prefix=`):
 * `""` for the root, or a prefix ending in `/`, at most `MAX_KEY_BYTES`, not
 * under one of `reserved`. It comes from a listing, so it is taken as given,
 * never normalised.
 */
export function checkBrowsePrefix(
  prefix: string,
  reserved: readonly string[] = BOUND_RESERVED_PREFIXES,
): "invalid_path" | "reserved_path" | null {
  if (prefix === "") {
    return null;
  }

  return checkFolderPrefix(prefix, reserved);
}

/**
 * Checks a folder's prefix as delete-folder takes it: as browse does, except
 * that the root is refused, since it cannot be deleted.
 */
export function checkFolderPrefix(
  prefix: string,
  reserved: readonly string[] = BOUND_RESERVED_PREFIXES,
): "invalid_path" | "reserved_path" | null {
  if (!prefix.endsWith("/") || utf8Length(prefix) > MAX_KEY_BYTES) {
    return "invalid_path";
  }

  return isReservedKey(prefix, reserved) ? "reserved_path" : null;
}
