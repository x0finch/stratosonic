import { env } from "cloudflare:test";
import { type MockInstance, vi } from "vitest";
import type { StorageCredentials } from "../src/storage/credentials";
import type { S3Location } from "../src/storage/s3";
import { oracleSignature } from "./sigv4-oracle";

/**
 * A fake R2 S3 endpoint (#84, "Testing Decisions", "Fake S3"): the S3
 * operations the S3 client (storage/s3.ts) makes, answered from a second
 * miniflare bucket, `LIBRARY_TEST` (vitest.config.ts), as R2 answers them.
 *
 * It is installed over `fetch` (`installFakeS3`, with `vi.spyOn`, as
 * usage-api.test.ts stands in for Cloudflare's API), and:
 *
 * - verifies every request's SigV4 `Authorization` header with the
 *   independent oracle (test/sigv4-oracle.ts), over the path exactly as
 *   sent, and its `X-Amz-Content-Sha256` against the bytes received (never
 *   `UNSIGNED-PAYLOAD`), answering `403 SignatureDoesNotMatch` (or
 *   `InvalidAccessKeyId`) when either is wrong;
 * - implements `ListObjectsV2` (`list-type=2`, `max-keys`, `prefix`,
 *   `delimiter`, `continuation-token`, `encoding-type=url`), `HeadObject`,
 *   ranged `GetObject`, `PutObject` with `If-None-Match: *`, `DeleteObject`
 *   and `DeleteObjects` with its `Content-MD5` check and a strict reading
 *   of its XML (a raw `<`, a bare `&` or a character XML 1.0 refuses is
 *   `400 MalformedXML`);
 * - answers a continuation token it never issued with `400
 *   InvalidArgument`, as S3 does;
 * - can be switched (`fail`) to answer 401, 403, `NoSuchBucket`,
 *   `SlowDown`, 429, 500 or a redirect, to fail as a network does, to
 *   report a key `DeleteObjects` did not delete, to answer a ranged read
 *   with another range than asked, or to answer a listing without its
 *   `<EncodingType>` echo; and a failure can be kept to some operations, or
 *   to some keys;
 * - records every call (`calls`), signature verdict included.
 *
 * `encoding-type=url` is answered as S3 encodes it, a form encoding: a
 * space is `+`, and every other byte but `A-Z a-z 0-9 - _ . ~ /` is `%XX`.
 */

/** The S3 operations the fake knows. */
export type S3Operation =
  | "ListObjectsV2"
  | "HeadObject"
  | "GetObject"
  | "PutObject"
  | "DeleteObject"
  | "DeleteObjects"
  | "Unknown";

/** What the fake can be switched to answer instead of the operation. */
export type FakeS3Failure =
  | "access_denied"
  | "unauthorized"
  | "no_such_bucket"
  | "slow_down"
  | "too_many_requests"
  | "server_error"
  | "redirect"
  | "network"
  | "delete_error"
  /** A ranged `GetObject` answers the range one byte later than asked. */
  | "wrong_range"
  /** A ranged `GetObject` answers one byte more than asked, when there is one. */
  | "long_range"
  /**
   * A `ListObjectsV2` answers 200 without echoing `<EncodingType>url</EncodingType>`,
   * so its keys' encoding is unknown and the client refuses the page.
   */
  | "no_encoding_echo";

/** The failures answered inside an operation's own answer. */
const IN_ANSWER: ReadonlySet<FakeS3Failure> = new Set([
  "delete_error",
  "wrong_range",
  "long_range",
  "no_encoding_echo",
]);

/** One request the fake received. */
export interface FakeS3Call {
  readonly operation: S3Operation;
  readonly method: string;
  readonly url: string;
  /** The object key, for an object operation. */
  readonly key?: string;
  /** How many keys a `DeleteObjects` carried. */
  readonly keys?: number;
  readonly signatureValid: boolean;
  /** The status answered, or `network` for a simulated network failure. */
  status: number | "network";
}

export interface FakeS3Options {
  readonly accountId?: string;
  readonly bucket?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
}

/** The second bucket the fake serves from (vitest.config.ts). */
export function libraryTestBucket(): R2Bucket {
  return (env as unknown as { LIBRARY_TEST: R2Bucket }).LIBRARY_TEST;
}

const encoder = new TextEncoder();
const XMLNS = "http://s3.amazonaws.com/doc/2006-03-01/";

export class FakeS3 {
  readonly accountId: string;
  readonly host: string;
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Every request received, in order. */
  readonly calls: FakeS3Call[] = [];

  #failure: {
    failure: FakeS3Failure;
    operations: ReadonlySet<S3Operation> | null;
    keys: ReadonlySet<string> | null;
  } | null = null;
  #tokens = new Map<string, string>();
  #issued = 0;

  constructor(options: FakeS3Options = {}) {
    this.accountId = options.accountId ?? "fedcba9876543210fedcba9876543210";
    this.host = `${this.accountId}.r2.cloudflarestorage.com`;
    this.endpoint = `https://${this.host}`;
    this.bucket = options.bucket ?? "archive";
    this.accessKeyId = options.accessKeyId ?? "fake-s3-access-key-id";
    this.secretAccessKey = options.secretAccessKey ?? "fake+s3/secret=access-key-not-real";
  }

  /** The library's location, as `s3Storage` takes it. */
  location(libraryId = 2): S3Location {
    return { libraryId, endpoint: this.endpoint, bucket: this.bucket };
  }

  /** The token the fake accepts. */
  credentials(): StorageCredentials {
    return { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey };
  }

  /**
   * Answers every request (or only those of `operations`, and of those only
   * the requests for one of `keys`) with `failure` from now on, or, with
   * null, as S3 again.
   */
  fail(
    failure: FakeS3Failure | null,
    operations?: readonly S3Operation[],
    keys?: readonly string[],
  ): void {
    this.#failure =
      failure === null
        ? null
        : {
            failure,
            operations: operations === undefined ? null : new Set(operations),
            keys: keys === undefined ? null : new Set(keys),
          };
  }

  /** How many keys each `DeleteObjects` carried, in order. */
  deleteCalls(): number[] {
    return this.calls
      .filter((call) => call.operation === "DeleteObjects" && call.keys !== undefined)
      .map((call) => call.keys ?? 0);
  }

  /** Answers one request, as R2's S3 endpoint would. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());
    const { operation, key, bucket } = this.#route(request.method, url);
    const signature = await this.#verify(request, url, body);
    const call: FakeS3Call = {
      operation,
      method: request.method,
      url: request.url,
      ...(key === undefined ? {} : { key }),
      signatureValid: signature === "valid",
      status: 0,
    };
    this.calls.push(call);

    const answer = (response: Response) => {
      call.status = response.status;
      return request.method === "HEAD" ? withoutBody(response) : response;
    };

    if (signature !== "valid") {
      return answer(errorResponse(403, signature));
    }

    const failure = this.#failure;
    // `delete_error` and the range failures are answered inside the
    // operation's own answer, below.
    if (
      failure !== null &&
      !IN_ANSWER.has(failure.failure) &&
      (failure.operations === null || failure.operations.has(operation)) &&
      (failure.keys === null || (key !== undefined && failure.keys.has(key)))
    ) {
      if (failure.failure === "network") {
        call.status = "network";
        throw new TypeError("Network connection lost.");
      }
      return answer(failureResponse(failure.failure, this.endpoint));
    }

    if (bucket !== this.bucket) {
      return answer(errorResponse(404, "NoSuchBucket"));
    }

    const storage = libraryTestBucket();
    switch (operation) {
      case "ListObjectsV2":
        return answer(await this.#list(storage, url, failure?.failure === "no_encoding_echo"));
      case "HeadObject":
        return answer(await headObject(storage, key ?? ""));
      case "GetObject": {
        const skew =
          failure?.failure === "wrong_range"
            ? "start"
            : failure?.failure === "long_range"
              ? "end"
              : null;
        return answer(await getObject(storage, key ?? "", request.headers.get("Range"), skew));
      }
      case "PutObject":
        return answer(await putObject(storage, key ?? "", body, request.headers));
      case "DeleteObject":
        await storage.delete(key ?? "");
        return answer(new Response(null, { status: 204 }));
      case "DeleteObjects": {
        const deleted = await this.#deleteObjects(storage, body, request.headers);
        if (typeof deleted.keys === "number") {
          Object.assign(call, { keys: deleted.keys });
        }
        return answer(deleted.response);
      }
      default:
        return answer(errorResponse(400, "NotImplemented"));
    }
  }

  #route(method: string, url: URL): { operation: S3Operation; bucket: string; key?: string } {
    const [bucket = "", ...segments] = url.pathname.slice(1).split("/").map(decodeURIComponent);
    if (segments.length === 0) {
      if (method === "GET" && url.searchParams.get("list-type") === "2") {
        return { operation: "ListObjectsV2", bucket };
      }
      if (method === "POST" && url.searchParams.has("delete")) {
        return { operation: "DeleteObjects", bucket };
      }
      return { operation: "Unknown", bucket };
    }
    const key = segments.join("/");
    const operation: S3Operation =
      method === "HEAD"
        ? "HeadObject"
        : method === "GET"
          ? "GetObject"
          : method === "PUT"
            ? "PutObject"
            : method === "DELETE"
              ? "DeleteObject"
              : "Unknown";
    return { operation, bucket, key };
  }

  /** `valid`, or the S3 error code a request with this signature gets. */
  async #verify(
    request: Request,
    url: URL,
    body: Uint8Array,
  ): Promise<"valid" | "InvalidAccessKeyId" | "SignatureDoesNotMatch"> {
    const match =
      /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/.exec(
        request.headers.get("Authorization") ?? "",
      );
    if (match === null) {
      return "SignatureDoesNotMatch";
    }
    const [, accessKeyId, date, region, service, signedHeaders = "", signature] = match;
    if (accessKeyId !== this.accessKeyId) {
      return "InvalidAccessKeyId";
    }
    const amzDate = request.headers.get("X-Amz-Date") ?? "";
    const payloadHash = request.headers.get("X-Amz-Content-Sha256") ?? "";
    const names = signedHeaders.split(";");
    if (
      region !== "auto" ||
      service !== "s3" ||
      amzDate.slice(0, 8) !== date ||
      !names.includes("host") ||
      !names.includes("x-amz-date") ||
      !names.includes("x-amz-content-sha256") ||
      // Every request is header-signed over its payload: `UNSIGNED-PAYLOAD`
      // is for presigned URLs only, and a hash must be the body's.
      payloadHash !== (await sha256Hex(body))
    ) {
      return "SignatureDoesNotMatch";
    }

    const headers: Record<string, string> = {};
    for (const name of names) {
      if (name === "host") continue;
      const value = request.headers.get(name);
      if (value === null) {
        return "SignatureDoesNotMatch";
      }
      headers[name] = value;
    }
    const expected = await oracleSignature({
      method: request.method,
      host: url.host,
      // The path as sent, as R2 takes it: it verifies only if the client
      // sent exactly the canonical path it signed, each segment encoded once.
      canonicalPath: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      secretAccessKey: this.secretAccessKey,
      amzDate,
      region: "auto",
      service: "s3",
      payloadHash,
    });
    return expected === signature ? "valid" : "SignatureDoesNotMatch";
  }

  async #list(storage: R2Bucket, url: URL, withoutEncodingEcho = false): Promise<Response> {
    const query = url.searchParams;
    const maxKeys = Number(query.get("max-keys") ?? "1000");
    if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 1000) {
      return errorResponse(400, "InvalidArgument");
    }
    const prefix = query.get("prefix") ?? undefined;
    const delimiter = query.get("delimiter") ?? undefined;
    const token = query.get("continuation-token");
    const encode = query.get("encoding-type") === "url" ? s3UrlEncode : escapeXml;

    let cursor: string | undefined;
    if (token !== null) {
      cursor = this.#tokens.get(token);
      if (cursor === undefined) {
        return errorResponse(400, "InvalidArgument");
      }
    }

    const listing = await storage.list({ prefix, delimiter, cursor, limit: maxKeys });
    let next = "";
    if (listing.truncated) {
      // Characters an XML body must escape, so the client's unescaping of
      // the token is exercised.
      next = `fake+token/${++this.#issued}&=<"'>`;
      this.#tokens.set(next, listing.cursor);
    }

    const parts = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<ListBucketResult xmlns="${XMLNS}">`,
      `<Name>${this.bucket}</Name>`,
      `<Prefix>${encode(prefix ?? "")}</Prefix>`,
      `<KeyCount>${listing.objects.length + listing.delimitedPrefixes.length}</KeyCount>`,
      `<MaxKeys>${maxKeys}</MaxKeys>`,
      delimiter === undefined ? "" : `<Delimiter>${encode(delimiter)}</Delimiter>`,
      query.get("encoding-type") === "url" && !withoutEncodingEcho
        ? "<EncodingType>url</EncodingType>"
        : "",
      `<IsTruncated>${listing.truncated}</IsTruncated>`,
      token === null ? "" : `<ContinuationToken>${escapeXml(token)}</ContinuationToken>`,
      next === "" ? "" : `<NextContinuationToken>${escapeXml(next)}</NextContinuationToken>`,
      ...listing.objects.map(
        (object) =>
          `<Contents><Key>${encode(object.key)}</Key>` +
          `<LastModified>${object.uploaded.toISOString()}</LastModified>` +
          `<ETag>&quot;${object.etag}&quot;</ETag><Size>${object.size}</Size>` +
          `<StorageClass>STANDARD</StorageClass></Contents>`,
      ),
      ...listing.delimitedPrefixes.map(
        (folder) => `<CommonPrefixes><Prefix>${encode(folder)}</Prefix></CommonPrefixes>`,
      ),
      "</ListBucketResult>",
    ];
    return xmlResponse(200, parts.join(""));
  }

  async #deleteObjects(
    storage: R2Bucket,
    body: Uint8Array,
    headers: Headers,
  ): Promise<{ response: Response; keys?: number }> {
    const md5 = headers.get("Content-MD5");
    if (md5 === null) {
      return { response: errorResponse(400, "MissingContentMD5") };
    }
    const digest = new Uint8Array(await crypto.subtle.digest("MD5", body));
    if (md5 !== btoa(String.fromCharCode(...digest))) {
      return { response: errorResponse(400, "BadDigest") };
    }

    // Well-formed XML of exactly the shape S3 takes, as an XML parser would
    // demand it: a raw `<` in a key breaks the structure, and a bare `&`, or
    // a character XML 1.0 has no place for, is refused.
    const xml = new TextDecoder().decode(body);
    const shape =
      /^<\?xml[^>]*\?><Delete(?: xmlns="[^"]*")?>(?:<Quiet>(?:true|false)<\/Quiet>)?((?:<Object><Key>[^<]*<\/Key><\/Object>)+)<\/Delete>$/;
    const objects = shape.exec(xml)?.[1];
    if (objects === undefined) {
      return { response: errorResponse(400, "MalformedXML") };
    }
    const texts = [...objects.matchAll(/<Key>([^<]*)<\/Key>/g)].map((match) => match[1] ?? "");
    const entity = /&(?:#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;
    if (
      texts.some(
        (text) =>
          text.replace(entity, "").includes("&") ||
          // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/.test(text),
      )
    ) {
      return { response: errorResponse(400, "MalformedXML") };
    }
    const keys = texts.map(unescapeXmlText);
    if (keys.length > 1000) {
      return { response: errorResponse(400, "MalformedXML") };
    }

    if (this.#failure?.failure === "delete_error") {
      return {
        response: xmlResponse(
          200,
          `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="${XMLNS}">` +
            `<Error><Key>${escapeXml(keys[0] ?? "")}</Key><Code>AccessDenied</Code>` +
            "<Message>Access Denied</Message></Error></DeleteResult>",
        ),
        keys: keys.length,
      };
    }

    await storage.delete(keys);
    return {
      response: xmlResponse(
        200,
        `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="${XMLNS}"></DeleteResult>`,
      ),
      keys: keys.length,
    };
  }
}

/**
 * Puts the fakes in front of `fetch`: a request to a fake's host is answered
 * by it, one to any other R2 endpoint fails as an unknown host does, and
 * anything else goes to the real `fetch`. Restore it with
 * `vi.restoreAllMocks()` or the returned spy's `mockRestore()`.
 */
export function installFakeS3(...fakes: FakeS3[]): MockInstance<typeof fetch> {
  const original = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const host = new URL(request.url).host;
    const fake = fakes.find((candidate) => candidate.host === host);
    if (fake !== undefined) {
      return fake.handle(request);
    }
    if (host.endsWith(".r2.cloudflarestorage.com")) {
      throw new TypeError(`no fake S3 answers ${host}`);
    }
    return original(input, init);
  });
}

/* --------------------------------------------------------- operations -- */

function objectHeaders(object: R2Object): Headers {
  const headers = new Headers({
    ETag: `"${object.etag}"`,
    "Last-Modified": object.uploaded.toUTCString(),
  });
  const contentType = object.httpMetadata?.contentType;
  if (contentType !== undefined) {
    headers.set("Content-Type", contentType);
  }
  return headers;
}

async function headObject(storage: R2Bucket, key: string): Promise<Response> {
  const object = await storage.head(key);
  if (object === null) {
    return new Response(null, { status: 404 });
  }
  const headers = objectHeaders(object);
  headers.set("Content-Length", String(object.size));
  return new Response(null, { status: 200, headers });
}

async function getObject(
  storage: R2Bucket,
  key: string,
  range: string | null,
  skew: "start" | "end" | null = null,
): Promise<Response> {
  const head = await storage.head(key);
  if (head === null) {
    return errorResponse(404, "NoSuchKey");
  }
  const headers = objectHeaders(head);

  if (range === null) {
    const object = await storage.get(key);
    if (object === null) {
      return errorResponse(404, "NoSuchKey");
    }
    headers.set("Content-Length", String(object.size));
    return new Response(object.body, { status: 200, headers });
  }

  const match = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (match === null) {
    return errorResponse(400, "InvalidArgument");
  }
  const requestedStart = Number(match[1]);
  const requestedEnd = match[2] === "" ? head.size - 1 : Number(match[2]);
  if (requestedStart >= head.size || requestedEnd < requestedStart) {
    headers.set("Content-Range", `bytes */${head.size}`);
    return xmlResponse(416, errorXml("InvalidRange"), headers);
  }
  // A misbehaving server, when switched to be one: another range than asked.
  const last = head.size - 1;
  const start = skew === "start" ? Math.min(requestedStart + 1, last) : requestedStart;
  const end = Math.min(skew === "end" ? requestedEnd + 1 : requestedEnd, last);
  const object = await storage.get(key, { range: { offset: start, length: end - start + 1 } });
  if (object === null) {
    return errorResponse(404, "NoSuchKey");
  }
  headers.set("Content-Range", `bytes ${start}-${end}/${head.size}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(object.body, { status: 206, headers });
}

async function putObject(
  storage: R2Bucket,
  key: string,
  body: Uint8Array,
  headers: Headers,
): Promise<Response> {
  const options: R2PutOptions = {};
  const contentType = headers.get("Content-Type");
  if (contentType !== null) options.httpMetadata = { contentType };
  if (headers.get("If-None-Match") === "*") {
    options.onlyIf = new Headers({ "If-None-Match": "*" });
  }

  const object = await storage.put(key, body, options);
  if (object === null) {
    return errorResponse(412, "PreconditionFailed");
  }
  return new Response(null, {
    status: 200,
    headers: { ETag: `"${object.etag}"`, Date: object.uploaded.toUTCString() },
  });
}

/* ------------------------------------------------------------ answers -- */

function failureResponse(failure: FakeS3Failure, endpoint: string): Response {
  switch (failure) {
    case "access_denied":
      return errorResponse(403, "AccessDenied");
    case "unauthorized":
      return errorResponse(401, "Unauthorized");
    case "no_such_bucket":
      return errorResponse(404, "NoSuchBucket");
    case "slow_down":
      return errorResponse(503, "SlowDown");
    case "too_many_requests":
      return errorResponse(429, "TooManyRequests");
    case "redirect":
      return new Response(null, { status: 307, headers: { Location: `${endpoint}/elsewhere` } });
    default:
      return errorResponse(500, "InternalError");
  }
}

function errorXml(code: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`;
}

function errorResponse(status: number, code: string): Response {
  return xmlResponse(status, errorXml(code));
}

function xmlResponse(status: number, xml: string, headers = new Headers()): Response {
  headers.set("Content-Type", "application/xml");
  return new Response(xml, { status, headers });
}

/** A `HEAD`'s answer: the status and headers, never a body. */
function withoutBody(response: Response): Response {
  void response.body?.cancel();
  return new Response(null, { status: response.status, headers: response.headers });
}

/** S3's `encoding-type=url`: a form encoding that keeps `/`. */
function s3UrlEncode(value: string): string {
  let encoded = "";
  for (const byte of encoder.encode(value)) {
    const character = String.fromCharCode(byte);
    encoded +=
      character === " "
        ? "+"
        : /^[A-Za-z0-9\-_.~/]$/.test(character)
          ? character
          : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function unescapeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (entity in named) return named[entity] ?? "";
    return String.fromCodePoint(
      entity[1] === "x" || entity[1] === "X"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10),
    );
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
