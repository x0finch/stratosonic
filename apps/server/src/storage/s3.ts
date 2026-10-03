import type { StorageCredentials } from "./credentials";
import {
  awsClientFor,
  bucketUrl,
  encodeSegment,
  isAddressableKey,
  objectUrl,
  presignUpload,
  type S3Bucket,
} from "./presign";
import { parseListObjectsV2, unescapeXml, unquoteEtag } from "./s3-list";
import {
  type ByteRange,
  checkRange,
  DELETE_KEYS_PER_CALL,
  emptyBody,
  type LibraryStorage,
  StorageError,
  type StorageFailure,
  type StoredBody,
  type StoredObject,
  UnaddressableKeyError,
} from "./storage";

/**
 * An R2 bucket other than the bound one, reached through the S3 API over
 * `fetch` and signed with SigV4 by `aws4fetch` (#84, "Storage interface";
 * ADR-0009): a connected library's `LibraryStorage`.
 *
 * Each operation is one S3 request, as each binding call it stands for is
 * one subrequest, so a scan step costs what it costs on the bound bucket
 * (#84, "The step budget, recomputed for S3"):
 *
 * - `list` is `ListObjectsV2` (`list-type=2`, `max-keys`, `prefix`,
 *   `delimiter`, `continuation-token` and `encoding-type=url`), read by
 *   storage/s3-list.ts;
 * - `head` is `HeadObject`, `get` a `GetObject` with `Range`, whose
 *   `Content-Range` gives the whole object's size; a range at or past the
 *   end (`416`), or one of no bytes, costs one `HeadObject` instead or more;
 * - `put` is `PutObject`, with `If-None-Match: *` for `onlyIfAbsent`;
 * - `delete` is one `DeleteObjects` a thousand keys, with the `Content-MD5`
 *   S3 requires on it, plus one `DeleteObject` for each key holding a
 *   character XML 1.0 cannot carry, a C0 control character, U+FFFE or
 *   U+FFFF (`deleteRequests` counts them, for callers that budget
 *   subrequests);
 * - `presignPut` signs locally and sends nothing.
 *
 * Every request carries the SHA-256 of its payload as
 * `X-Amz-Content-Sha256`, signed, and is sent with `redirect: "manual"`: a
 * redirect would cost a subrequest, and S3 has no business sending one, so a
 * 3xx is `unavailable`. Nothing is retried here; the scan driver has its
 * backoff.
 *
 * **Where requests may go.** The endpoint is asserted against
 * `^https://[0-9a-f]{32}\.r2\.cloudflarestorage\.com$`, and the bucket
 * against R2's naming rule, and, for a row, both against the `path` its
 * token is sealed for, on every use, before the token is opened, so a
 * tampered row cannot send a signed request elsewhere. A key with a `.` or
 * `..` segment is refused before any URL is built (`UnaddressableKeyError`,
 * storage/presign.ts): the URL parser would collapse it into another
 * object's path.
 *
 * **Failures** are `StorageError`s, from the status and the S3 error code
 * (R2 docs, "Error codes"):
 *
 * - `auth`: `401 Unauthorized`, which R2 answers for a key it does not know,
 *   and `403` `AccessDenied`, `InvalidAccessKeyId` or
 *   `SignatureDoesNotMatch`, or a `403` with no body (a `HEAD`); and a stored
 *   token that does not open (a rotated `PASSWORD_ENCRYPTION_KEY`);
 * - `bucket_not_found`: `NoSuchBucket`;
 * - `throttled`: `429`, or `503 SlowDown`;
 * - `invalid_cursor`: `400 InvalidArgument` on a listing that carried a
 *   continuation token;
 * - `unavailable`: any other status, a network error, a 3xx, an answer that
 *   is not what S3 sends, and a location that fails its assertion.
 *
 * A missing object is `null`, as the binding answers. A `HEAD` has no body,
 * so a `404` to one cannot tell a missing bucket from a missing key, and is
 * `null`; the listing every scan starts with tells the bucket apart.
 */

/** An R2 account's S3 endpoint, and nothing else. */
export const R2_ENDPOINT = /^https:\/\/[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/;

/** R2's bucket names: 3-63 of `a-z 0-9 -`, starting and ending with a letter or digit. */
const R2_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** Where a library's bucket is. */
export interface S3Location extends S3Bucket {
  readonly libraryId: number;
  /**
   * The library's storage URI, `s3://<endpoint host>/<bucket>`, when the
   * location comes from a row: its sealed token is bound to the path alone
   * (storage/credentials.ts), so the endpoint and bucket must be the ones
   * the path names, or a tampered row could aim a valid token elsewhere.
   */
  readonly path?: string;
}

/** The storage URI of a bucket on an R2 endpoint, as `library.path` holds it. */
export function s3Path({ endpoint, bucket }: S3Bucket): string {
  return `s3://${endpoint.slice("https://".length)}/${bucket}`;
}

/**
 * The library's token: given, or opened on the first request that needs it
 * (a sealed `library.credentials`, storage/credentials.ts).
 */
export type CredentialsSource = StorageCredentials | (() => Promise<StorageCredentials>);

/** SHA-256 of no bytes, the payload hash of a request without a body. */
const EMPTY_PAYLOAD_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** The S3 error codes that mean the token was refused. */
const AUTH_CODES = new Set(["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch"]);

const encoder = new TextEncoder();

/** A connected library's bucket, over the S3 API. */
export function s3Storage(location: S3Location, credentials: CredentialsSource): LibraryStorage {
  const { libraryId } = location;
  let opened: StorageCredentials | null = typeof credentials === "function" ? null : credentials;

  /** The bucket, once its location has passed the assertions. */
  function bucket(): S3Bucket {
    if (!R2_ENDPOINT.test(location.endpoint)) {
      throw new StorageError("unavailable", "the library's endpoint is not an R2 S3 endpoint");
    }
    if (!R2_BUCKET.test(location.bucket)) {
      throw new StorageError("unavailable", "the library's bucket is not an R2 bucket name");
    }
    if (location.path !== undefined && location.path !== s3Path(location)) {
      throw new StorageError(
        "unavailable",
        "the library's path does not name its endpoint and bucket",
      );
    }
    return location;
  }

  /** The token, opened once for this storage (one request's, or one scan step's). */
  async function token(): Promise<StorageCredentials> {
    if (opened !== null) {
      return opened;
    }
    if (typeof credentials !== "function") {
      return credentials;
    }
    try {
      opened = await credentials();
    } catch (cause) {
      throw new StorageError("auth", "the library's stored credentials do not open", { cause });
    }
    return opened;
  }

  /** Signs and sends one request; a network error or a 3xx is `unavailable`. */
  async function send(
    operation: string,
    url: URL,
    init: { method: string; headers?: Record<string, string>; body?: Uint8Array },
  ): Promise<Response> {
    const { accessKeyId, secretAccessKey } = await token();
    const payloadHash = init.body === undefined ? EMPTY_PAYLOAD_HASH : await sha256Hex(init.body);
    const signed = await awsClientFor(libraryId, { accessKeyId, secretAccessKey }).sign(url, {
      method: init.method,
      headers: { ...init.headers, "X-Amz-Content-Sha256": payloadHash },
      body: init.body,
      redirect: "manual",
    });

    let response: Response;
    try {
      response = await fetch(signed);
    } catch (cause) {
      throw new StorageError("unavailable", `${operation}: the bucket did not answer`, { cause });
    }
    if (response.status >= 300 && response.status < 400) {
      await discard(response);
      throw new StorageError("unavailable", `${operation} was answered with a ${response.status}`);
    }
    return response;
  }

  /** A `404` to an object request: a missing key, or a missing bucket. */
  async function missing(operation: string, response: Response): Promise<null> {
    const code = errorCode(await readText(operation, response));
    if (code === "NoSuchBucket") {
      throw new StorageError("bucket_not_found", `${operation} answered 404 NoSuchBucket`);
    }
    return null;
  }

  async function head(key: string): Promise<StoredObject | null> {
    const url = objectUrl(bucket(), key);
    const response = await send("HeadObject", url, { method: "HEAD" });
    if (response.status === 404) {
      await discard(response);
      return null;
    }
    if (response.status !== 200) {
      throw await failure("HeadObject", response);
    }
    await discard(response);

    return describe("HeadObject", key, response.headers, contentLength("HeadObject", response));
  }

  async function get(key: string, range?: ByteRange): Promise<StoredBody | null> {
    const url = objectUrl(bucket(), key);
    if (range === undefined) {
      const response = await send("GetObject", url, { method: "GET" });
      if (response.status === 404) {
        return missing("GetObject", response);
      }
      if (response.status !== 200) {
        throw await failure("GetObject", response);
      }
      const object = describe(
        "GetObject",
        key,
        response.headers,
        contentLength("GetObject", response),
      );
      return withBody(object, response);
    }

    checkRange(range);
    if (range.length === 0) {
      // Nothing to read, and a range S3 cannot express.
      const object = await head(key);
      return object === null ? null : emptyBody(object);
    }

    const last = range.offset + range.length - 1;
    const response = await send("GetObject", url, {
      method: "GET",
      headers: { Range: `bytes=${range.offset}-${last}` },
    });
    switch (response.status) {
      case 206: {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get("Content-Range") ?? "",
        );
        // The bytes asked for, clamped to the object, and nothing else.
        const total = Number(match?.[3]);
        if (
          match === null ||
          Number(match[1]) !== range.offset ||
          Number(match[2]) !== Math.min(last, total - 1)
        ) {
          await discard(response);
          throw new StorageError("unavailable", "GetObject answered a range it was not asked for");
        }
        const object = describe("GetObject", key, response.headers, Number(match[3]));
        return withBody(object, response);
      }
      case 200: {
        // The whole object: what a range covering all of it may answer, an
        // empty object's included. Anything else would be the wrong bytes.
        const size = contentLength("GetObject", response);
        if (range.offset !== 0 || range.length < size) {
          await discard(response);
          throw new StorageError("unavailable", "GetObject ignored the range it was asked for");
        }
        return withBody(describe("GetObject", key, response.headers, size), response);
      }
      case 416: {
        // A range that starts at or past the end. Only then is the object's
        // size asked for, so an ordinary read costs nothing more.
        await discard(response);
        const object = await head(key);
        if (object === null) {
          return null;
        }
        if (range.offset < object.size) {
          throw new StorageError("unavailable", "GetObject refused a range inside the object");
        }
        return emptyBody(object);
      }
      case 404:
        return missing("GetObject", response);
      default:
        throw await failure("GetObject", response);
    }
  }

  async function deleteObjects(keys: readonly string[]): Promise<void> {
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Delete xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Quiet>true</Quiet>' +
      keys.map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`).join("") +
      "</Delete>";
    const body = encoder.encode(xml);
    const md5 = await crypto.subtle.digest("MD5", body);

    const url = bucketUrl(bucket());
    url.search = "delete";
    const response = await send("DeleteObjects", url, {
      method: "POST",
      headers: { "Content-MD5": toBase64(new Uint8Array(md5)), "Content-Type": "application/xml" },
      body,
    });
    if (response.status !== 200) {
      throw await failure("DeleteObjects", response);
    }
    checkDeleteResult(await readText("DeleteObjects", response));
  }

  async function deleteObject(key: string): Promise<void> {
    const response = await send("DeleteObject", objectUrl(bucket(), key), { method: "DELETE" });
    if (response.status === 204 || response.status === 200) {
      await discard(response);
      return;
    }
    if (response.status === 404) {
      // A key that is not there is not an error.
      await missing("DeleteObject", response);
      return;
    }
    throw await failure("DeleteObject", response);
  }

  return {
    libraryId,

    async list({ prefix, delimiter, cursor, limit }) {
      const url = bucketUrl(bucket());
      const query: [string, string][] = [
        ["list-type", "2"],
        ["encoding-type", "url"],
        ["max-keys", String(limit)],
      ];
      if (prefix !== undefined && prefix !== "") query.push(["prefix", prefix]);
      if (delimiter !== undefined) query.push(["delimiter", delimiter]);
      if (cursor !== undefined) query.push(["continuation-token", cursor]);
      // Encoded as SigV4 encodes it (`%20`, never `+`), so the query sent is
      // the one signed, whatever the server makes of a `+`.
      url.search = query.map(([name, value]) => `${name}=${encodeSegment(value)}`).join("&");

      const response = await send("ListObjectsV2", url, { method: "GET" });
      if (response.status !== 200) {
        throw await failure("ListObjectsV2", response, cursor !== undefined);
      }
      return parseListObjectsV2(await readText("ListObjectsV2", response));
    },

    head,

    get,

    async put(key, body, options = {}) {
      const { contentType, onlyIfAbsent } = options;
      const url = objectUrl(bucket(), key);
      const headers: Record<string, string> = {};
      if (contentType !== undefined) headers["Content-Type"] = contentType;
      if (onlyIfAbsent === true) headers["If-None-Match"] = "*";

      const response = await send("PutObject", url, { method: "PUT", headers, body });
      if (response.status === 412) {
        await discard(response);
        return null;
      }
      if (response.status !== 200) {
        throw await failure("PutObject", response);
      }
      await discard(response);

      const etag = response.headers.get("ETag");
      if (etag === null) {
        throw new StorageError("unavailable", "PutObject answered no ETag");
      }
      // `PutObject` answers no `Last-Modified`, and a `HeadObject` would be
      // another subrequest: the second the bucket answered at is the closest
      // to the write, and a listing has it to the millisecond.
      const answeredAt = Date.parse(response.headers.get("Date") ?? "");
      const stored: StoredObject = {
        key,
        size: body.byteLength,
        etag: unquoteEtag(etag),
        uploaded: new Date(Number.isNaN(answeredAt) ? Date.now() : answeredAt),
      };
      return contentType === undefined ? stored : { ...stored, contentType };
    },

    async delete(keys) {
      if (keys.length === 0) {
        return;
      }
      const batched: string[] = [];
      const alone: string[] = [];
      for (const key of keys) {
        (notInXml(key) ? alone : batched).push(key);
      }
      // A key deleted alone goes in a URL: refuse an unaddressable one before
      // anything is deleted.
      const unaddressable = alone.find((key) => !isAddressableKey(key));
      if (unaddressable !== undefined) {
        throw new UnaddressableKeyError(unaddressable);
      }
      bucket();

      for (let start = 0; start < batched.length; start += DELETE_KEYS_PER_CALL) {
        await deleteObjects(batched.slice(start, start + DELETE_KEYS_PER_CALL));
      }
      for (const key of alone) {
        await deleteObject(key);
      }
    },

    async presignPut(upload, now) {
      const target = bucket();
      if (!isAddressableKey(upload.key)) {
        throw new UnaddressableKeyError(upload.key);
      }
      return presignUpload({ ...target, libraryId, credentials: await token() }, upload, now);
    },
  };
}

/**
 * The requests `delete(keys)` makes: one `DeleteObjects` a thousand keys
 * that XML can carry, and one `DeleteObject` for each key that it cannot.
 */
export function deleteRequests(keys: readonly string[]): number {
  let alone = 0;
  for (const key of keys) {
    if (notInXml(key)) alone++;
  }
  return Math.ceil((keys.length - alone) / DELETE_KEYS_PER_CALL) + alone;
}

/**
 * The reason for a failed request (R2 docs, "Error codes"; #84, "Storage
 * interface"), from its status, its S3 error code when it had a body, and
 * whether it carried a continuation token.
 */
export function failureReason(status: number, code: string | null, cursor = false): StorageFailure {
  if (status === 401) {
    return "auth";
  }
  if (status === 403) {
    return code === null || AUTH_CODES.has(code) ? "auth" : "unavailable";
  }
  if (code === "NoSuchBucket") {
    return "bucket_not_found";
  }
  if (status === 429 || (status === 503 && code === "SlowDown")) {
    return "throttled";
  }
  if (status === 400 && code === "InvalidArgument" && cursor) {
    return "invalid_cursor";
  }
  return "unavailable";
}

async function failure(operation: string, response: Response, cursor = false) {
  const code = errorCode(await readText(operation, response).catch(() => ""));
  const reason = failureReason(response.status, code, cursor);
  return new StorageError(
    reason,
    `${operation} answered ${response.status}${code === null ? "" : ` ${code}`}`,
  );
}

/** The `<Code>` of an S3 error body, or null. */
function errorCode(xml: string): string | null {
  const match = /<Code>([^<]*)<\/Code>/.exec(xml);
  return match === null ? null : (match[1] ?? null);
}

/**
 * A `DeleteObjects` answer. In quiet mode it lists only the keys that were
 * not deleted, each as an `<Error>`; a key that was not there is not one.
 */
function checkDeleteResult(xml: string): void {
  if (xml.indexOf("<DeleteResult") === -1) {
    throw new StorageError("unavailable", "DeleteObjects answered no <DeleteResult>");
  }
  for (let at = xml.indexOf("<Error>"); at !== -1; at = xml.indexOf("<Error>", at + 7)) {
    const close = xml.indexOf("</Error>", at);
    const code = errorCode(xml.slice(at, close === -1 ? undefined : close));
    if (code === "NoSuchKey") {
      continue;
    }
    throw new StorageError(
      code !== null && AUTH_CODES.has(code) ? "auth" : "unavailable",
      `DeleteObjects did not delete a key: ${code === null ? "no code" : unescapeXml(code)}`,
    );
  }
}

/** What a response's headers say about the object. */
function describe(operation: string, key: string, headers: Headers, size: number): StoredObject {
  const etag = headers.get("ETag");
  const uploaded = Date.parse(headers.get("Last-Modified") ?? "");
  if (etag === null || Number.isNaN(uploaded) || !Number.isSafeInteger(size) || size < 0) {
    throw new StorageError("unavailable", `${operation} answered no ETag, Last-Modified or size`);
  }
  const contentType = headers.get("Content-Type");
  const object: StoredObject = { key, size, etag: unquoteEtag(etag), uploaded: new Date(uploaded) };

  return contentType === null ? object : { ...object, contentType };
}

function contentLength(operation: string, response: Response): number {
  const length = response.headers.get("Content-Length");
  if (length === null || !/^\d+$/.test(length)) {
    throw new StorageError("unavailable", `${operation} answered no Content-Length`);
  }
  return Number(length);
}

function withBody(object: StoredObject, response: Response): StoredBody {
  const body = response.body ?? new Blob([]).stream();
  return {
    ...object,
    body,
    bytes: async () => new Uint8Array(await response.arrayBuffer()),
    cancel: () => body.cancel(),
  };
}

async function readText(operation: string, response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (cause) {
    throw new StorageError("unavailable", `${operation}: the answer was cut off`, { cause });
  }
}

/** Lets an answer's body go unread. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to let go of.
  }
}

/**
 * Whether a key holds a character XML 1.0 cannot carry (its `Char`
 * production): a C0 control character, U+FFFE or U+FFFF, or a lone
 * surrogate. Such a key is deleted alone, in a URL, which carries any
 * well-formed key; a lone surrogate's is refused there before anything is
 * sent.
 */
function notInXml(key: string): boolean {
  return (
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
    /[\u0000-\u001f￾￿]/.test(key) || !(key as string & { isWellFormed(): boolean }).isWellFormed()
  );
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
