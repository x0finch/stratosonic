import { AwsClient } from "aws4fetch";
import type { UploadsConfig } from "./config";

/**
 * Presigning the browser's upload of one file (#83, "Signing" and "What a URL
 * binds"): a SigV4 query-signed `PUT` to the bucket's S3 endpoint, which the
 * console sends straight to R2, so the file's bytes never pass through the
 * Worker.
 *
 * The URL is path-style, `https://<account>.r2.cloudflarestorage.com/
 * <bucket>/<key>`, the S3 endpoint the R2 docs give, and the only host a
 * presigned URL works on (never a bucket's custom domain). Each segment of
 * the bucket and the key is percent-encoded as RFC 3986 asks, so the path
 * the URL carries is exactly the canonical path that is signed.
 *
 * A URL is a bearer token, so it binds everything a leak could abuse:
 *
 * - the method and the key, in the canonical request;
 * - the expiry, `X-Amz-Expires=300`, five minutes from the instant signed;
 * - the size, as the signed `content-length`: only a body of exactly that
 *   many bytes is accepted;
 * - the type, as the signed `content-type`, the allow-list's for the suffix;
 * - no overwrite, as the signed `if-none-match: *`, unless the owner chose
 *   Replace: R2 answers `412` for a key that exists, which also closes the
 *   race between the route's `head()` and the `PUT`.
 *
 * The signed headers are therefore exactly
 * `content-length;content-type;host;if-none-match`, or the same without
 * `if-none-match` on Replace. The browser sets `Content-Length` itself from
 * the file (it is a forbidden request header), so the answer names only the
 * headers the console must send.
 *
 * The signing is `aws4fetch`'s, the library the R2 docs sign with from a
 * Worker; an independent SigV4 in the tests recomputes every signature
 * (test/files-sign.test.ts). The secret key never leaves this module's
 * client: no URL, answer or log line carries it.
 */

/** How long a presigned URL lives: five minutes, checked when the `PUT` arrives. */
export const UPLOAD_URL_TTL_SECONDS = 300;

/** One file to presign. */
export interface UploadToSign {
  /** The exact key to write: a new key in NFC, or the stored spelling on Replace. */
  readonly key: string;
  /** The exact size of the body, in bytes. */
  readonly size: number;
  /** The allow-list's content type for the key's suffix. */
  readonly contentType: string;
  /** Whether the URL may replace an existing object: signed without `If-None-Match`. */
  readonly replace: boolean;
}

/** A presigned upload, as `POST /api/files/uploads` answers it. */
export interface PresignedUpload {
  readonly url: string;
  readonly method: "PUT";
  /** The headers the console sends, exactly these. */
  readonly headers: Readonly<Record<string, string>>;
  /** When the URL stops working, to the second, as ISO 8601. */
  readonly expiresAt: string;
}

/**
 * The isolate's client, built on the first upload signed. Only the resolved
 * client is kept, never a promise one request shares with another
 * (setup/initial-setup.ts), and it is rebuilt if the token changes. It keeps
 * the signing key it derives for each day, so a batch derives it once.
 */
let cached: {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  client: AwsClient;
} | null = null;

function clientFor({ accessKeyId, secretAccessKey }: UploadsConfig): AwsClient {
  if (
    cached === null ||
    cached.accessKeyId !== accessKeyId ||
    cached.secretAccessKey !== secretAccessKey
  ) {
    cached = {
      accessKeyId,
      secretAccessKey,
      client: new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" }),
    };
  }

  return cached.client;
}

/**
 * Presigns the `PUT` of one file, as of `now` (epoch milliseconds, truncated
 * to the second as SigV4's `X-Amz-Date` is): the URL, the headers to send
 * and when it expires, all from the same instant.
 */
export async function presignUpload(
  config: UploadsConfig,
  upload: UploadToSign,
  now: number = Date.now(),
): Promise<PresignedUpload> {
  const signedAt = Math.floor(now / 1000) * 1000;
  const url = objectUrl(config, upload.key);
  // Before signing, so it is one of the signed query parameters.
  url.searchParams.set("X-Amz-Expires", String(UPLOAD_URL_TTL_SECONDS));

  const headers: Record<string, string> = { "Content-Type": upload.contentType };
  if (!upload.replace) {
    headers["If-None-Match"] = "*";
  }

  const signed = await clientFor(config).sign(url, {
    method: "PUT",
    headers: { ...headers, "Content-Length": String(upload.size) },
    // `allHeaders`: without it, aws4fetch leaves `Content-Length` and
    // `Content-Type` out of the signature.
    aws: { signQuery: true, allHeaders: true, datetime: amzDate(signedAt) },
  });

  return {
    url: signed.url,
    method: "PUT",
    headers,
    expiresAt: new Date(signedAt + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
  };
}

/** The object's path-style URL on the bucket's S3 endpoint, without a query. */
export function objectUrl({ accountId, bucket }: UploadsConfig, key: string): URL {
  const path = [bucket, ...key.split("/")].map(encodeSegment).join("/");
  return new URL(`https://${accountId}.r2.cloudflarestorage.com/${path}`);
}

/**
 * One path segment as SigV4 encodes it: every byte but RFC 3986's unreserved
 * characters (`A–Z a–z 0–9 - . _ ~`) as `%XX`, so a space is `%20`, a `+` is
 * `%2B` and an apostrophe is `%27`.
 */
export function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** SigV4's `X-Amz-Date`: `YYYYMMDD'T'HHMMSS'Z'`. */
function amzDate(at: number): string {
  return new Date(at).toISOString().replace(/[:-]|\.\d{3}/g, "");
}
