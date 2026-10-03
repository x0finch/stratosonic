import { suffixOf } from "../library/audio-formats";
import { PLAYLIST_SUFFIXES } from "../playlists/m3u";
import type { StoredObject } from "../storage/storage";
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
  /** The listing's cursor when there is another page, else null. */
  readonly cursor: string | null;
}

/** What `folderListing` reads of a delimited listing (storage/storage.ts). */
export interface DelimitedListing {
  readonly prefixes: readonly string[];
  readonly objects: readonly Pick<StoredObject, "key" | "size" | "uploaded">[];
  readonly cursor: string | null;
}

/**
 * A delimited listing of `prefix` as the console sees it: folders and
 * files, each in the bucket's order (lexicographic by key). `_covers/`, the
 * scanner's, is dropped from the root's folders, and an object named like
 * the folder itself, a "folder marker" some S3 tools write, is not a file
 * in it.
 */
export function folderListing(prefix: string, listing: DelimitedListing): FolderListing {
  return {
    prefix,
    folders: listing.prefixes
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
    cursor: listing.cursor,
  };
}

/** The keys among these that name a playlist, by suffix, case ignored. */
export function playlistKeysOf(keys: readonly string[]): string[] {
  return keys.filter((key) => PLAYLIST_SUFFIXES.includes(suffixOf(key)));
}
