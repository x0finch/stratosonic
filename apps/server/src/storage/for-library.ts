import type { Library } from "@stratosonic/db";
import type { Env } from "../env";
import { BOUND_LIBRARY_ID, bindingStorage } from "./binding";
import { openCredentials } from "./credentials";
import { s3Storage } from "./s3";
import type { LibraryStorage } from "./storage";

/**
 * What `storageFor` reads of a library row: the columns that say where its
 * bucket is and how it is reached (packages/db, `library`).
 */
export type StorageRow = Pick<
  Library,
  "id" | "kind" | "path" | "endpoint" | "bucket" | "credentials"
>;

/**
 * A library's storage, from the row the caller already read (#84, "Storage
 * interface"), after Navidrome's scheme registry (`core/storage/storage.go:
 * For`), which picks an implementation by the library path's scheme:
 *
 * - `r2-binding`: the bound bucket, `MUSIC` (`bindingStorage`). Only library
 *   1 is bound, and a row of another id claiming the binding is refused;
 * - `s3`: the bucket over the S3 API (`s3Storage`), with the row's sealed
 *   token opened under `PASSWORD_ENCRYPTION_KEY` and the row's `path` on the
 *   first request that needs it, so a route that never reaches the bucket
 *   decrypts nothing. A token that does not open, or a row without one, is
 *   `StorageError("auth")`, and a missing endpoint or bucket fails the S3
 *   client's assertions (`unavailable`), on use.
 *
 * It reads nothing itself: no D1 statement, no subrequest.
 */
export function storageFor(env: Env, library: StorageRow): LibraryStorage {
  switch (library.kind) {
    case "r2-binding":
      if (library.id !== BOUND_LIBRARY_ID) {
        throw new Error(`library ${library.id} claims the binding, which only library 1 is`);
      }
      return bindingStorage(env);
    case "s3": {
      const { id, path, credentials: sealed } = library;
      const passphrase = env.PASSWORD_ENCRYPTION_KEY ?? "";
      return s3Storage(
        { libraryId: id, endpoint: library.endpoint ?? "", bucket: library.bucket ?? "" },
        () =>
          sealed === null
            ? Promise.reject(new Error(`library ${id} has no stored credentials`))
            : openCredentials(passphrase, path, sealed),
      );
    }
    default:
      throw new Error(`library ${library.id} has an unknown kind`);
  }
}
