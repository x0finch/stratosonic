import type { PresignedUpload, UploadToSign } from "./presign";

/**
 * The bucket a library's files live in, as the rest of the Worker sees it
 * (#84, "Storage interface").
 *
 * Every read and write of a library's objects goes through a
 * `LibraryStorage`: the scan's listing and range reads, the covers it
 * writes, streaming, lyrics sidecars, playlist files and the console's Files
 * page. Nothing outside `storage/` touches the `MUSIC` binding. The
 * interface is the seam a second kind of bucket plugs into, and it is kept
 * to what those callers need: six operations, plain values in and out, and
 * nothing of the binding's own types.
 *
 * It has two implementations: the bound bucket, through its binding
 * (`storage/binding.ts`), and any other R2 bucket, through the S3 API
 * (`storage/s3.ts`); `storageFor` (storage/for-library.ts) picks one from a
 * library row. What every implementation promises is pinned by one contract
 * suite, run against both (test/storage-contract.test.ts).
 */

/** What a bucket says about one object. */
export interface StoredObject {
  /** The key exactly as the bucket stores it, never normalised. */
  readonly key: string;
  /** The whole object's length in bytes, even when a range of it was read. */
  readonly size: number;
  /** The entity tag, unquoted: equal for equal bytes written the same way. */
  readonly etag: string;
  /**
   * When the object was last written: the only timestamp an object has. A
   * listing gives it to the millisecond. Over the S3 API, a `head` or `get`
   * gives it to the second (`Last-Modified`), and a `put` gives the second
   * the bucket answered at (`Date`), so a listing is the authority for it.
   */
  readonly uploaded: Date;
  /**
   * The content type stored with the object, when there is one. A listing
   * may leave it out even where a `head` would answer it.
   */
  readonly contentType?: string;
}

/** One page of a listing. */
export interface StorageListing {
  /** The objects of the page, in key order. */
  readonly objects: StoredObject[];
  /**
   * The common prefixes, each ending in the delimiter, when the listing was
   * delimited: the "folders" of the prefix listed. Empty otherwise.
   */
  readonly prefixes: string[];
  /** Where the next page starts, opaque, or null on the last page. */
  readonly cursor: string | null;
}

/** An object and its bytes, or the range of them that was asked for. */
export interface StoredBody extends StoredObject {
  /** The bytes, as a stream: read it once, or `cancel()` it. */
  readonly body: ReadableStream<Uint8Array>;
  /** Reads the whole body into memory. */
  bytes(): Promise<Uint8Array>;
  /** Lets the body go unread, rather than leaving the runtime to drain it. */
  cancel(): Promise<void>;
}

/** A range of an object's bytes: `[offset, offset + length)`. */
export interface ByteRange {
  readonly offset: number;
  readonly length: number;
}

/** What a listing asks for. */
export interface ListOptions {
  /** Only keys starting with this. */
  readonly prefix?: string;
  /** Group the keys past the prefix by their next `/` into `prefixes`. */
  readonly delimiter?: "/";
  /** A cursor an earlier page of the same listing answered. */
  readonly cursor?: string;
  /** The most entries (objects and prefixes) the page holds, 1-1,000. */
  readonly limit: number;
}

/** What a `put` asks for beyond the bytes. */
export interface PutOptions {
  /** The content type to store with the object. */
  readonly contentType?: string;
  /** Write only when no object has the key; otherwise refuse (`null`). */
  readonly onlyIfAbsent?: boolean;
}

/** The most keys one bulk delete of the bucket takes. */
export const DELETE_KEYS_PER_CALL = 1000;

/** One library's bucket. */
export interface LibraryStorage {
  /** The library whose bucket this is. */
  readonly libraryId: number;
  /** One page of keys, in key order. */
  list(options: ListOptions): Promise<StorageListing>;
  /** What the bucket knows about one key, or null when it holds no such object. */
  head(key: string): Promise<StoredObject | null>;
  /**
   * The object's bytes, or the range of them asked for, or null when the
   * bucket holds no such object. The range is clamped to the object: it
   * reads short when it runs past the end, and empty when it starts at or
   * past it, as `ByteSource` reads do (library/byte-source.ts).
   */
  get(key: string, range?: ByteRange): Promise<StoredBody | null>;
  /**
   * Writes an object and answers what was stored, or null when the bucket
   * refused the write (`onlyIfAbsent` and the key exists).
   */
  put(key: string, body: Uint8Array, options?: PutOptions): Promise<StoredObject | null>;
  /**
   * Deletes these keys, in one call per `DELETE_KEYS_PER_CALL` keys and none
   * for no key. A key that is not there is not an error. A call that fails
   * throws, and the keys of the calls before it are gone.
   */
  delete(keys: readonly string[]): Promise<void>;
  /**
   * A presigned `PUT` the browser uploads one file with, so its bytes never
   * pass through the Worker, or null when uploads are not configured for
   * this bucket. `now` is epoch milliseconds.
   */
  presignPut(upload: UploadToSign, now?: number): Promise<PresignedUpload | null>;
}

/**
 * Why a bucket failed, as far as a caller acts on it:
 *
 * - `auth`: the credentials were refused;
 * - `bucket_not_found`: the bucket does not exist;
 * - `throttled`: the bucket asked us to slow down;
 * - `invalid_cursor`: a listing's cursor was refused;
 * - `unavailable`: anything else, including the network.
 *
 * A missing *object* is never a failure: it is the `null` the operations
 * answer.
 */
export type StorageFailure =
  | "auth"
  | "bucket_not_found"
  | "throttled"
  | "invalid_cursor"
  | "unavailable";

/**
 * A bucket failure with its reason. An implementation raises one only where
 * it can tell the reason. The S3 client (`storage/s3.ts`) always can; the
 * binding (`storage/binding.ts`) cannot, and lets the binding's own
 * exception through, which a caller reads as `unavailable`.
 */
export class StorageError extends Error {
  readonly reason: StorageFailure;

  constructor(reason: StorageFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
    this.reason = reason;
  }
}

/** Refuses a range whose offset or length is negative or not whole. */
export function checkRange({ offset, length }: ByteRange): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`a range's offset must be a non-negative integer, got ${offset}`);
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`a range's length must be a non-negative integer, got ${length}`);
  }
}

/** No bytes of an object: what a range at or past its end reads. */
export function emptyBody(object: StoredObject): StoredBody {
  return {
    ...object,
    body: new Blob([]).stream(),
    bytes: async () => new Uint8Array(0),
    cancel: async () => {},
  };
}

/**
 * A key the storage cannot name in a request, raised before any request is
 * made. Over the S3 API that is a key with a `.` or `..` segment, which the
 * URL parser would collapse into another object's path
 * (storage/presign.ts, `objectUrl`). It is a property of the key, not a
 * failure of the bucket: the scan counts such an object broken.
 */
export class UnaddressableKeyError extends Error {
  readonly key: string;

  constructor(key: string) {
    super("the key has a dot segment, which a path-style URL cannot carry");
    this.name = "UnaddressableKeyError";
    this.key = key;
  }
}
