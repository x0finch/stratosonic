/**
 * How a pass judges a library whose listing failed (#84, "Skipping a
 * library"), in the scan phase and the playlist import alike.
 *
 * Only a failed **`list`** judges the whole library: a failed read of one
 * object stays that object's `deferred` (or broken, for a key the storage
 * cannot name), as it always was.
 *
 * - `auth` or `bucket_not_found` skips the library at once: one batch writes
 *   its `last_scan_error` and moves the pass on. Its tracks stay.
 * - `invalid_cursor`, a stale continuation token, restarts that library's
 *   listing from its start, once.
 * - `throttled` and `unavailable` (and a cursor refused again) are a
 *   `LibraryListingError`: the driver retries with its backoff and, after
 *   `maxFailures`, skips the library with `unavailable` rather than giving
 *   the pass up, which would park every later library and the playlists on
 *   it. Failures of anything else (D1, a bug) keep the driver's give-up.
 *
 * The bound bucket's binding raises no `StorageError` (storage/binding.ts),
 * so on library 1 every failure reads as `unavailable`, a refused cursor
 * included, and is retried, then skipped.
 */

import { StorageError, type StorageFailure } from "../storage/storage";

/**
 * A library's listing failed in a way that may pass. The driver retries the
 * step with its backoff, and after `maxFailures` skips the library.
 */
export class LibraryListingError extends Error {
  readonly libraryId: number;
  readonly reason: StorageFailure;

  constructor(libraryId: number, reason: StorageFailure, options?: { cause?: unknown }) {
    super(`library ${libraryId}: the listing failed (${reason})`, options);
    this.name = "LibraryListingError";
    this.libraryId = libraryId;
    this.reason = reason;
  }
}

/** Why a listing failed, as the rules read it: anything unexplained is `unavailable`. */
export function listingFailure(error: unknown): StorageFailure {
  return error instanceof StorageError ? error.reason : "unavailable";
}

/** Whether a failed listing skips its library at once, without a retry. */
export function skipsAtOnce(reason: StorageFailure): boolean {
  return reason === "auth" || reason === "bucket_not_found";
}
