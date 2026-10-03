import type { Env } from "../env";
import { uploadsStatus } from "../files/config";
import { presignUpload } from "../files/sign";
import {
  type ByteRange,
  DELETE_KEYS_PER_CALL,
  type LibraryStorage,
  type StorageListing,
  type StoredBody,
  type StoredObject,
} from "./storage";

/**
 * The bucket `wrangler.jsonc` binds as `MUSIC`, behind `LibraryStorage`: the
 * Worker's one library today, library 1.
 *
 * It makes exactly the binding calls the callers made before the interface
 * existed - one `list`, `head`, `get` or `put` an operation, and one `delete`
 * a thousand keys - so it costs no subrequest and no R2 operation more. The
 * binding is read from `env` on every call, never kept, so a test that
 * wraps `env.MUSIC` sees every call this makes.
 *
 * What it adds is translation: the binding's objects are `StoredObject`s
 * (R2's `etag` is unquoted already, and `httpEtag` is that etag in quotes),
 * with the stored content type lifted out of `httpMetadata`, and a range that
 * starts at or past an object's end, which the binding refuses, reads empty,
 * as the interface promises.
 *
 * Failures are the binding's own exceptions, passed through unchanged: R2's
 * Workers API reports a code at the end of a message, not the statuses a
 * `StorageError` reason is read from, and it answers a cursor it never
 * issued with an empty page in local runs, so no reason could be told
 * reliably.
 *
 * Uploads are presigned for the bucket's S3 endpoint with Phase 2's secrets
 * (files/config.ts, `uploadsStatus`), and `presignPut` answers null until
 * they are configured.
 */

/** The library the bound bucket is: the first, which can never be removed. */
export const BOUND_LIBRARY_ID = 1;

/** The bound bucket, `MUSIC`, as library 1's storage. */
export function bindingStorage(env: Env): LibraryStorage {
  return {
    libraryId: BOUND_LIBRARY_ID,

    async list({ prefix, delimiter, cursor, limit }) {
      // Only the options given, so the binding is asked exactly what it was
      // asked before.
      const options: R2ListOptions = { limit };
      if (prefix !== undefined) options.prefix = prefix;
      if (delimiter !== undefined) options.delimiter = delimiter;
      if (cursor !== undefined) options.cursor = cursor;

      return fromR2Listing(await env.MUSIC.list(options));
    },

    async head(key) {
      const object = await env.MUSIC.head(key);

      return object === null ? null : toStoredObject(object);
    },

    async get(key, range) {
      if (range === undefined) {
        const object = await env.MUSIC.get(key);

        return object === null ? null : toStoredBody(object);
      }

      checkRange(range);
      if (range.length === 0) {
        // Nothing to read, and a range R2 would refuse.
        return emptyRead(env, key);
      }

      try {
        const object = await env.MUSIC.get(key, {
          range: { offset: range.offset, length: range.length },
        });

        return object === null ? null : toStoredBody(object);
      } catch (error) {
        // R2 clamps a range that runs past the end, but refuses one that
        // starts at or past it, an empty object's included. Only then does
        // this ask how long the object is, so an ordinary read costs nothing
        // more.
        if (!isRangeRefusal(error)) {
          throw error;
        }
        const head = await env.MUSIC.head(key);
        if (head === null) {
          return null;
        }
        if (range.offset < head.size) {
          throw error;
        }

        return emptyBody(toStoredObject(head));
      }
    },

    async put(key, body, options = {}) {
      const { contentType, onlyIfAbsent } = options;
      const put: R2PutOptions = {};
      if (contentType !== undefined) put.httpMetadata = { contentType };
      // `If-None-Match: *`, which R2 answers with null when the key exists.
      if (onlyIfAbsent === true) put.onlyIf = new Headers({ "If-None-Match": "*" });

      const object =
        contentType === undefined && onlyIfAbsent !== true
          ? await env.MUSIC.put(key, body)
          : await env.MUSIC.put(key, body, put);

      return object === null ? null : toStoredObject(object);
    },

    async delete(keys) {
      for (let start = 0; start < keys.length; start += DELETE_KEYS_PER_CALL) {
        await env.MUSIC.delete(keys.slice(start, start + DELETE_KEYS_PER_CALL));
      }
    },

    async presignPut(upload, now) {
      const status = uploadsStatus(env);

      return status.configured ? presignUpload(status.config, upload, now) : null;
    },
  };
}

/**
 * The bound bucket, named for the callers that always mean it whatever the
 * library: the covers the scan extracts and `getCoverArt` serves, which live
 * in the bound bucket's `_covers/` (scanner/covers.ts).
 */
export const boundStorage: (env: Env) => LibraryStorage = bindingStorage;

/**
 * A binding listing as a `StorageListing`.
 *
 * The binding's objects are handed on as they are, not copied: an
 * `R2Object` already is a `StoredObject` by shape - its key, size, unquoted
 * etag and upload time - and a listing does not carry the content type
 * unless asked to (`include`), which `StoredObject` allows. A page is a
 * thousand objects, so a copy of each would be CPU every listing pays for
 * nothing.
 */
export function fromR2Listing(listing: R2Objects): StorageListing {
  return {
    objects: listing.objects,
    prefixes: listing.delimitedPrefixes,
    cursor: listing.truncated ? listing.cursor : null,
  };
}

function toStoredObject(object: R2Object): StoredObject {
  const contentType = object.httpMetadata?.contentType;
  const stored = {
    key: object.key,
    size: object.size,
    etag: object.etag,
    uploaded: object.uploaded,
  };

  return contentType === undefined ? stored : { ...stored, contentType };
}

function toStoredBody(object: R2ObjectBody): StoredBody {
  return {
    ...toStoredObject(object),
    body: object.body,
    bytes: async () => new Uint8Array(await object.arrayBuffer()),
    cancel: () => object.body.cancel(),
  };
}

function emptyBody(object: StoredObject): StoredBody {
  return {
    ...object,
    body: new Blob([]).stream(),
    bytes: async () => new Uint8Array(0),
    cancel: async () => {},
  };
}

/** No bytes of an object that exists, or null when it does not. */
async function emptyRead(env: Env, key: string): Promise<StoredBody | null> {
  const head = await env.MUSIC.head(key);

  return head === null ? null : emptyBody(toStoredObject(head));
}

function checkRange({ offset, length }: ByteRange): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError(`a range's offset must be a non-negative integer, got ${offset}`);
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`a range's length must be a non-negative integer, got ${length}`);
  }
}

/**
 * Whether R2 refused a read for its range: code 10039, "The requested range
 * is not satisfiable", at the end of the message as R2's Workers API puts
 * it. Local runs (miniflare) answer code 0 for any range of an empty object.
 */
function isRangeRefusal(error: unknown): boolean {
  return error instanceof Error && /\((?:10039|0)\)$/.test(error.message);
}
