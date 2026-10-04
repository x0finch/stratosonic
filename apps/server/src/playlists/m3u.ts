/**
 * Reading an `.m3u` file: what it calls itself, and which R2 keys its lines
 * point at.
 *
 * Nothing here reads R2 or D1. It is handed the text of one playlist object
 * and the key that object lives under, and answers with a name and a list of
 * candidate keys - which is the part of the import that is easiest to get
 * subtly wrong and therefore the part worth testing on its own.
 *
 * ## What a line means
 *
 * The rules follow Navidrome's `parseM3U` (core/playlists/parse_m3u.go):
 *
 * - Every line is trimmed, which is also what removes the `\r` of a file
 *   written on Windows.
 * - `#PLAYLIST:<name>` names the playlist. Everything else beginning with
 *   `#` - `#EXTM3U`, `#EXTINF`, anything else extended - is skipped, and so
 *   are blank lines.
 * - A `file://` line has the scheme stripped and the rest percent-decoded, as
 *   Go's `url.PathUnescape` decodes it. A line that is not valid percent
 *   encoding is dropped, which is what Go's ignored error amounts to there.
 * - A line whose suffix is not one this server indexes is skipped rather than
 *   counted as missing: it could never have matched a Track, because the scan
 *   would not have indexed such a file either. Navidrome's `IsAudioFile`
 *   check does the same job.
 *
 * ## Where a line points
 *
 * Navidrome resolves a relative line against the playlist file's own
 * directory and an absolute one as it stands, then locates the result inside
 * a library root. The bucket *is* the library root here, so an absolute line
 * is the same path without its leading slash.
 *
 * A relative line is tried twice: first against the playlist's folder, then
 * as a key from the root of the bucket. That second candidate is a deliberate
 * addition. Navidrome's playlists sit inside the library they refer to, so
 * relative always means "near me"; a bucket keeps its `.m3u` files wherever
 * rclone put them - often a `playlists/` prefix beside the music rather than
 * inside it - and a line like `Artist/Album/01.mp3` then means the key, not
 * `playlists/Artist/Album/01.mp3`. Trying both can only match more of the
 * user's playlist, never the wrong track: a candidate either is a key in the
 * bucket or it is not.
 *
 * ## Across libraries
 *
 * Each library's bucket is its own root, and its `path` is a storage URI
 * (`r2-binding://MUSIC`, `s3://<endpoint host>/<bucket>`, ADR-0009). A line
 * that starts with a library's path names that library, as Navidrome's
 * absolute paths name whichever library holds them (`entryCandidates`), and
 * a written file spells another library's track that way (`playlistLine`).
 * Every other line is resolved in the playlist's own library, as above.
 */

import { isAudioKey, suffixOf } from "../library/audio-formats";

/**
 * The suffixes that make an object a playlist, as Navidrome's `IsValidPlaylist`.
 * The console's upload allow-list is built from them (files/keys.ts).
 */
export const PLAYLIST_SUFFIXES: readonly string[] = ["m3u", "m3u8"];

/** Prefix of the line that gives a playlist its name. */
const NAME_DIRECTIVE = "#PLAYLIST:";

/** What one `.m3u` file says. */
export interface ParsedM3u {
  /** The `#PLAYLIST:` name, or null when the file does not carry one. */
  readonly name: string | null;
  /** The path lines, in file order, with the extended lines removed. */
  readonly entries: readonly string[];
}

/** Whether this R2 key names a playlist the importer should read. */
export function isPlaylistKey(r2Key: string): boolean {
  return PLAYLIST_SUFFIXES.includes(suffixOf(r2Key)) && !isHiddenKey(r2Key);
}

/**
 * Whether the object's own name marks it hidden. Navidrome's playlist phase
 * skips a file whose name starts with a dot (scanner/phase_4_playlists.go),
 * which is how the tools that write these files spell "not mine to read".
 */
function isHiddenKey(r2Key: string): boolean {
  return baseName(r2Key).startsWith(".");
}

/**
 * The name a playlist has when its file does not name itself: the file name
 * without its extension, as Navidrome's `newSyncedPlaylist` takes it
 * (core/playlists/parse_nsp.go).
 */
export function playlistNameFromKey(r2Key: string): string {
  const name = baseName(r2Key);
  const dot = name.lastIndexOf(".");

  return dot <= 0 ? name : name.slice(0, dot);
}

/**
 * Reads the text of an `.m3u`.
 *
 * A byte-order mark is dropped first: a file saved as "UTF-8 with BOM" would
 * otherwise begin with an invisible character, which would hide the `#EXTM3U`
 * behind it and, worse, become part of the first path.
 */
export function parseM3u(text: string): ParsedM3u {
  const entries: string[] = [];
  let name: string | null = null;

  for (const rawLine of stripBom(text).split("\n")) {
    const line = rawLine.trim();

    if (line.startsWith(NAME_DIRECTIVE)) {
      name = line.slice(NAME_DIRECTIVE.length);
      continue;
    }

    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const path = readPath(line);
    if (path !== null && isAudioKey(path)) {
      entries.push(path);
    }
  }

  return { name: name === null || name === "" ? null : name, entries };
}

/**
 * The keys an entry could name, in the order they should be tried: at most
 * two, and none at all for a path that climbs above the root of the bucket.
 */
export function entryKeyCandidates(m3uKey: string, entry: string): readonly string[] {
  if (entry.startsWith("/")) {
    // Absolute: the bucket is the library root, so the leading slash is all
    // that separates the two spellings of the same key.
    return present(cleanPath(entry.slice(1)));
  }

  const folder = folderOf(m3uKey);
  const candidates = [cleanPath(folder === "" ? entry : `${folder}/${entry}`), cleanPath(entry)];

  return [...new Set(candidates.filter(isPresent))];
}

/* ----------------------------------------------- across libraries -- */

/** What entry resolution needs to know of a library: its id, path and whether it is served. */
export interface PlaylistLibrary {
  readonly id: number;
  /** The storage URI, `r2-binding://MUSIC` or `s3://<endpoint host>/<bucket>` (ADR-0009). */
  readonly path: string;
  /** Whether the library is `active`; a `removing` one resolves nothing. */
  readonly active: boolean;
}

/** The keys an entry could name, and the library they are keys of. */
export interface EntryCandidates {
  readonly libraryId: number;
  /** In the order they should be tried; none for a line that names nothing. */
  readonly keys: readonly string[];
}

/**
 * The library this line names by its path, or null when it starts with no
 * library's path: Navidrome's `libraryMatcher.findLibrary`
 * (core/playlists/parse_m3u.go), which matches an entry against every
 * library's path, **longest first**, so a path that is a prefix of another
 * (`s3://host/music` and `s3://host/music-classical`) cannot take the
 * other's lines, and only at a path boundary, so a line must go on with
 * `/`.
 */
export function libraryOfLine(
  line: string,
  libraries: readonly PlaylistLibrary[],
): PlaylistLibrary | null {
  let found: PlaylistLibrary | null = null;
  for (const candidate of libraries) {
    if (
      line.startsWith(`${candidate.path}/`) &&
      (found === null || candidate.path.length > found.path.length)
    ) {
      found = candidate;
    }
  }

  return found;
}

/**
 * The keys an entry of a playlist in library `libraryId` could name, and in
 * which library (#84, "Playlists across libraries"):
 *
 * - a line that starts with a library's `path` plus `/` names that library,
 *   with the rest of the line as the key, cleaned as Navidrome cleans an
 *   absolute path (`filepath.Clean`); one of a library that is not `active`
 *   names nothing, as a path outside every library does in Navidrome;
 * - any other line is a bare entry and resolves in the playlist's own
 *   library, exactly as `entryKeyCandidates` resolves it.
 */
export function entryCandidates(
  libraryId: number,
  m3uKey: string,
  entry: string,
  libraries: readonly PlaylistLibrary[],
): EntryCandidates {
  const named = libraryOfLine(entry, libraries);
  if (named === null) {
    return { libraryId, keys: entryKeyCandidates(m3uKey, entry) };
  }

  return {
    libraryId: named.id,
    keys: named.active ? present(cleanPath(entry.slice(named.path.length + 1))) : [],
  };
}

/**
 * The line a playlist in library `libraryId` writes for one of its tracks:
 * the bare key for a track of its own library, so a file of one library is
 * byte for byte what v0.5.0 wrote, and `<path>/<key>` for a track of
 * another, which `entryCandidates` reads back into that library (#84).
 * `renderM3u` then writes a bare key that begins with `#` in its absolute
 * spelling; a qualified line begins with its library's scheme, never `#`.
 */
export function playlistLine(
  libraryId: number,
  entry: { readonly libraryId: number; readonly r2Key: string },
  paths: ReadonlyMap<number, string>,
): string {
  if (entry.libraryId === libraryId) {
    return entry.r2Key;
  }

  const path = paths.get(entry.libraryId);
  if (path === undefined) {
    throw new Error(`playlists: no path for library ${entry.libraryId}`);
  }

  return `${path}/${entry.r2Key}`;
}

/** A `file://` URL becomes the path it names; anything else is already one. */
function readPath(line: string): string | null {
  if (!line.startsWith("file://")) {
    return line;
  }

  try {
    return decodeURIComponent(line.slice("file://".length));
  } catch {
    // Not valid percent encoding. Go's `url.PathUnescape` fails the same way,
    // and Navidrome drops the line by ignoring the error and keeping "".
    return null;
  }
}

/**
 * A key with `.` and `..` segments resolved and empty ones removed, or null
 * when the `..`s take it above the root - which names nothing in a bucket.
 */
function cleanPath(path: string): string | null {
  const resolved: string[] = [];

  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment !== "..") {
      resolved.push(segment);
      continue;
    }

    if (resolved.length === 0) {
      return null;
    }

    resolved.pop();
  }

  return resolved.length === 0 ? null : resolved.join("/");
}

/** The prefix an object lives under, or `""` for one at the root. */
function folderOf(r2Key: string): string {
  const slash = r2Key.lastIndexOf("/");

  return slash < 0 ? "" : r2Key.slice(0, slash);
}

function baseName(r2Key: string): string {
  return r2Key.slice(r2Key.lastIndexOf("/") + 1);
}

function stripBom(text: string): string {
  return text.startsWith("﻿") ? text.slice(1) : text;
}

function present(value: string | null): readonly string[] {
  return value === null ? [] : [value];
}

function isPresent(value: string | null): value is string {
  return value !== null;
}

/* ------------------------------------------------------------- writing -- */

/**
 * The text of an `.m3u`, the inverse of `parseM3u`: `#EXTM3U`, the
 * `#PLAYLIST:` name, then one key per line.
 *
 * The keys are written **root-relative** - a track's `r2_key` as it stands -
 * rather than relative to the folder the file is put in, because that is the
 * spelling the import already resolves without knowing where the `.m3u`
 * lives: `entryKeyCandidates` tries the key from the root as its second
 * candidate. A playlist written here therefore re-imports into the same
 * entries whether it sits under `playlists/` or anywhere else.
 *
 * A key that begins with `#` would be read back as a directive and dropped,
 * so it is written in the absolute spelling instead, which the parser strips
 * the leading slash from and resolves to the same key.
 */
export function renderM3u(name: string, entries: readonly string[]): string {
  const lines = ["#EXTM3U", `${NAME_DIRECTIVE}${playlistNameForFile(name)}`];

  for (const entry of entries) {
    lines.push(entry.startsWith("#") ? `/${entry}` : entry);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * A name as an `.m3u` can carry it, and therefore as it is stored: one line,
 * trimmed. A name holding a line break would otherwise end the directive and
 * turn its tail into a path, so the file and the row would disagree the
 * moment the next import read the file back.
 */
export function playlistNameForFile(name: string): string {
  return name.replace(/[\r\n]+/g, " ").trim();
}
