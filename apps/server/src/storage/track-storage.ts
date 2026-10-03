import { type Library, library } from "@stratosonic/db";
import type { Env } from "../env";
import { BOUND_LIBRARY_ID, bindingStorage } from "./binding";
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
 * (`storageRowColumns`) rather than spend a round trip on it.
 *
 * **Unless every track the caller can see is the bound bucket's.** A caller
 * whose libraries are library 1 alone, which is every caller of a
 * one-library server, needs no row: library 1 is always the binding. Their
 * lookups run v0.5.0's statement, with no join (`joinsLibraryRow`).
 */

/**
 * What a library row says about reaching its bucket: the columns a storage
 * is built from.
 */
export type StorageRow = Pick<
  Library,
  "id" | "kind" | "path" | "endpoint" | "bucket" | "credentials"
>;

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
 * track may be read without (`joinsLibraryRow`).
 */
export function storageOfTrack(
  env: Env,
  track: { readonly libraryId: number },
  row: StorageRow | null,
): LibraryStorage {
  if (row !== null) {
    return storageForRow(env, row);
  }
  if (track.libraryId === BOUND_LIBRARY_ID) {
    return bindingStorage(env);
  }

  throw new Error(`a track of library ${track.libraryId} was read without its library row`);
}

/**
 * A library's storage, from its row. The S3 client and `storageFor`
 * (storage/for-library.ts) arrive with #146; until then only the bound
 * bucket is reachable, and no other library can be connected (#84, ticket
 * G waits for this one).
 */
function storageForRow(env: Env, row: StorageRow): LibraryStorage {
  if (row.kind === "r2-binding" && row.id === BOUND_LIBRARY_ID) {
    return bindingStorage(env);
  }

  throw new Error(`library ${row.id} is reached over the S3 API, which arrives with #146`);
}
