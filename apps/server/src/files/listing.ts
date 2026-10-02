import { suffixOf } from "../library/audio-formats";
import { PLAYLIST_SUFFIXES } from "../playlists/m3u";
import { kindOf, type ListedKind, RESERVED_PREFIX } from "./keys";

/**
 * The CPU work of the Files routes, apart from the routes, so it can be read,
 * tested and benchmarked on its own (`GET /api/files`, the delete routes;
 * api/files.ts).
 */

/** A folder of the folder browsed. */
export interface FolderView {
  readonly name: string;
  readonly prefix: string;
}

/** A file of the folder browsed. */
export interface FileView {
  readonly name: string;
  readonly key: string;
  readonly size: number;
  /** R2's `uploaded`, the only timestamp an object has. */
  readonly uploadedAt: string;
  readonly kind: ListedKind;
}

/** One page of one folder, as `GET /api/files` answers it. */
export interface FolderListing {
  readonly prefix: string;
  readonly folders: readonly FolderView[];
  readonly files: readonly FileView[];
  /** R2's cursor when the listing was truncated, else null. */
  readonly cursor: string | null;
}

/** What `folderListing` reads of an R2 delimited listing. */
export interface DelimitedListing {
  readonly delimitedPrefixes: readonly string[];
  readonly objects: readonly Pick<R2Object, "key" | "size" | "uploaded">[];
  readonly truncated: boolean;
  readonly cursor?: string;
}

/**
 * A delimited listing of `prefix` as the console sees it: folders and
 * files, each in R2's order (lexicographic by key). `_covers/`, the
 * scanner's, is dropped from the root's folders, and an object named like
 * the folder itself, a "folder marker" some S3 tools write, is not a file
 * in it.
 */
export function folderListing(prefix: string, listing: DelimitedListing): FolderListing {
  return {
    prefix,
    folders: listing.delimitedPrefixes
      .filter((folder) => folder !== RESERVED_PREFIX)
      .map((folder) => ({ name: folder.slice(prefix.length, -1), prefix: folder })),
    files: listing.objects
      .filter((object) => object.key !== prefix)
      .map((object) => ({
        name: object.key.slice(prefix.length),
        key: object.key,
        size: object.size,
        uploadedAt: object.uploaded.toISOString(),
        kind: kindOf(object.key),
      })),
    cursor: listing.truncated ? (listing.cursor ?? null) : null,
  };
}

/** The keys among these that name a playlist, by suffix, case ignored. */
export function playlistKeysOf(keys: readonly string[]): string[] {
  return keys.filter((key) => PLAYLIST_SUFFIXES.includes(suffixOf(key)));
}
