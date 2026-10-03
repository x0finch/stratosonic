import { library } from "@stratosonic/db";
import type { Env } from "../env";
import { BOUND_LIBRARY_ID, bindingStorage } from "./binding";
import { type StorageRow, storageFor } from "./for-library";
import type { LibraryStorage } from "./storage";

/**
 * Where a track's bytes are read from: its own library's storage (#84,
 * "storage per track's library"). `stream`, `download`, `getLyricsBySongId`
 * and `getLyrics` read through it; covers do not, since every library's
 * covers are in the bound bucket (ADR-0009).
 *
 * **The library row comes with the track.** A library other than the bound
 * one is reached with what its row says (kind, endpoint, bucket, sealed
 * token), so the reads that serve bytes join `library` onto the track lookup
 * (`storageRowColumns`) rather than spend a round trip on it, and hand the
 * row to `storageFor` (storage/for-library.ts).
 *
 * **Unless every track the caller can see is the bound bucket's.** A caller
 * whose libraries are library 1 alone, which is every caller of a
 * one-library server, needs no row: library 1 is always the binding. Their
 * lookups run v0.5.0's statement, with no join (`joinsLibraryRow`).
 */

export type { StorageRow };

/** `StorageRow`'s columns, for a select that joins `library`. */
export const storageRowColumns = {
  id: library.id,
  kind: library.kind,
  path: library.path,
  endpoint: library.endpoint,
  bucket: library.bucket,
  credentials: library.credentials,
};

/**
 * Whether a lookup of a track this caller may read must join its library
 * row: true unless the only library they can see is the bound one.
 */
export function joinsLibraryRow(libraryIds: readonly number[]): boolean {
  return libraryIds.some((id) => id !== BOUND_LIBRARY_ID);
}

/**
 * The storage a track's bytes are read from: its library row's, when the
 * lookup joined one, and otherwise the binding, which only a library-1
 * track may be read without (`joinsLibraryRow`). Nothing is read or sent
 * here: an S3 library's token is opened on its first request.
 */
export function storageOfTrack(
  env: Env,
  track: { readonly libraryId: number },
  row: StorageRow | null,
): LibraryStorage {
  if (row !== null) {
    return storageFor(env, row);
  }
  if (track.libraryId === BOUND_LIBRARY_ID) {
    return bindingStorage(env);
  }

  throw new Error(`a track of library ${track.libraryId} was read without its library row`);
}
