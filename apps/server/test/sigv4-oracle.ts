/**
 * An independent SigV4 query presigner (AWS Signature Version 4, "Create a
 * signed request" and S3's "Authenticating Requests: Using Query
 * Parameters"), on WebCrypto and nothing else: the test oracle for
 * files/sign.ts, which signs with aws4fetch. It is written from the
 * specification, not from aws4fetch, and checked against AWS's own worked
 * example (test/files-sign.test.ts), so a signature both compute alike is
 * one R2 computes alike too.
 *
 * Used only in tests: production signs with aws4fetch (#83, "Signing").
 */

const encoder = new TextEncoder();

/**
 * SigV4's `UriEncode`: every byte of the UTF-8 but the unreserved
 * `A–Z a–z 0–9 - . _ ~` as `%XX`, upper-case hex. `/` is encoded too, so a
 * path is encoded segment by segment.
 */
export function uriEncode(value: string): string {
  let encoded = "";
  for (const byte of encoder.encode(value)) {
    const character = String.fromCharCode(byte);
    encoded += /^[A-Za-z0-9\-._~]$/.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/** The canonical URI of an object key in a bucket, path-style. */
export function canonicalObjectPath(bucket: string, key: string): string {
  return `/${[bucket, ...key.split("/")].map(uriEncode).join("/")}`;
}

export interface OracleRequest {
  readonly method: string;
  readonly host: string;
  /** Already canonical (`canonicalObjectPath`). */
  readonly canonicalPath: string;
  /** The query parameters but `X-Amz-Signature`, unencoded. */
  readonly query: Readonly<Record<string, string>>;
  /** The signed headers but `host`, by lower-case name. */
  readonly headers: Readonly<Record<string, string>>;
  readonly secretAccessKey: string;
  /** `YYYYMMDD'T'HHMMSS'Z'`. */
  readonly amzDate: string;
  readonly region: string;
  readonly service: string;
}

/** The hex signature of a query-signed request with an unsigned payload. */
export async function oracleSignature(request: OracleRequest): Promise<string> {
  const headers: Record<string, string> = { ...request.headers, host: request.host };
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]?.trim()}\n`).join("");
  const canonicalQuery = Object.entries(request.query)
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");

  const canonicalRequest = [
    request.method,
    request.canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    names.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const date = request.amzDate.slice(0, 8);
  const scope = `${date}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    request.amzDate,
    scope,
    hex(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalRequest))),
  ].join("\n");

  let key: ArrayBuffer = encoder.encode(`AWS4${request.secretAccessKey}`).buffer as ArrayBuffer;
  for (const part of [date, request.region, request.service, "aws4_request"]) {
    key = await hmac(key, part);
  }

  return hex(await hmac(key, stringToSign));
}

async function hmac(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
