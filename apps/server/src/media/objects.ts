/**
 * Serving one stored object to a client, whole or in part.
 *
 * The bucket gives us the bytes and almost none of the headers: never
 * `Content-Length`, `Content-Range` or `Accept-Ranges`. So every response is
 * built here — `head()` first for the size and the etag, the range decided
 * against that size, and only then a `get()` of exactly that range — and the
 * body is passed to the `Response` as the stream the bucket returned, never
 * read into memory: a Worker has 128 MB and a FLAC album side does not fit
 * in it.
 */

import type { LibraryStorage, StoredObject } from "../storage/storage";
import { SubsonicError, SubsonicErrorCode } from "../subsonic/response";
import { contentRange, parseByteRange, unsatisfiedContentRange } from "./range";

/** What to say about the bytes, beyond what the bucket already knows. */
export interface StoredObjectHeaders {
  /** The content type the client is told, decided by the caller. */
  readonly contentType: string;
  /** Set on a download, so the client saves the file instead of playing it. */
  readonly contentDisposition?: string;
}

/**
 * What the bucket knows about an object, or error 70 when it holds no such
 * object.
 *
 * A track's row can outlive the object it names — the bucket is written to out
 * of band with rclone, and a scan may not have swept the deletion yet — so
 * "not found" here is an ordinary answer, reported inside the envelope as any
 * other missing thing is.
 */
export async function headStoredObject(
  storage: LibraryStorage,
  key: string,
  message?: string,
): Promise<StoredObject> {
  const head = await storage.head(key);
  if (head === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound, message);
  }

  return head;
}

/**
 * Answers a request for an object whose `head()` has already been read.
 *
 * The caller passes the head it looked the object up with, so the object is
 * described once per request rather than twice.
 */
export async function serveStoredObject(
  storage: LibraryStorage,
  key: string,
  head: StoredObject,
  request: Request,
  options: StoredObjectHeaders,
): Promise<Response> {
  const size = head.size;
  const range = parseByteRange(request.headers.get("Range"), size);

  if (range.kind === "unsatisfiable") {
    // 416 carries no body and says how long the object actually is, which is
    // what lets a client that guessed wrong ask again correctly.
    return new Response(null, {
      status: 416,
      headers: { "Accept-Ranges": "bytes", "Content-Range": unsatisfiedContentRange(size) },
    });
  }

  const partial = range.kind === "partial";
  const offset = partial ? range.offset : 0;
  const length = partial ? range.length : size;

  const headers = new Headers({
    "Content-Type": options.contentType,
    "Content-Length": String(length),
    "Accept-Ranges": "bytes",
    // The etag is stored unquoted; HTTP quotes it.
    ETag: `"${head.etag}"`,
  });

  if (partial) {
    headers.set("Content-Range", contentRange(offset, length, size));
  }
  if (options.contentDisposition) {
    headers.set("Content-Disposition", options.contentDisposition);
  }

  const status = partial ? 206 : 200;

  // A HEAD asks what the bytes would be, not for them, and is answered from
  // the head() already in hand — a player probing a stream URL costs one
  // bucket operation and no egress.
  if (request.method === "HEAD") {
    return new Response(null, { status, headers });
  }

  const object = await storage.get(key, partial ? { offset, length } : undefined);
  if (object === null) {
    // Deleted between the head and the get.
    throw new SubsonicError(SubsonicErrorCode.NotFound);
  }

  return new Response(object.body, { status, headers });
}
