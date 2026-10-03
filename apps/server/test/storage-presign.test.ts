import { afterEach, describe, expect, it, vi } from "vitest";
import type { UploadsConfig } from "../src/files/config";
import {
  awsClientFor,
  bucketUrl,
  encodeSegment,
  isAddressableKey,
  objectUrl,
  type PresignedUpload,
  presignUpload,
  r2Endpoint,
  UPLOAD_URL_TTL_SECONDS,
  type UploadToSign,
} from "../src/storage/presign";
import { UnaddressableKeyError } from "../src/storage/storage";
import { canonicalObjectPath, oracleSignature, uriEncode } from "./sigv4-oracle";

/**
 * Presigning an upload (#83, "Signing", "What a URL binds"; storage/presign.ts),
 * in the Workers runtime the Worker signs in. Every URL is recomputed by an
 * independent SigV4 presigner (test/sigv4-oracle.ts), which is itself
 * checked against AWS's worked example first.
 *
 * Every credential here is made up.
 */

const CONFIG: UploadsConfig = {
  accessKeyId: "test-access-key-id",
  secretAccessKey: "test+secret/access=key-not-real",
  accountId: "0123456789abcdef0123456789abcdef",
  bucket: "navidrome",
};

/** Presigns for library 1, the bound bucket, as `bindingStorage` does. */
function presign(config: UploadsConfig, upload: UploadToSign, now?: number) {
  return presignUpload(
    {
      libraryId: 1,
      endpoint: r2Endpoint(config.accountId),
      bucket: config.bucket,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    },
    upload,
    now,
  );
}

/** 2026-10-02 12:34:56.789 UTC: signed as 12:34:56. */
const NOW = Date.UTC(2026, 9, 2, 12, 34, 56, 789);
const AMZ_DATE = "20261002T123456Z";

/** Keys with every character SigV4's encoding can get wrong. */
const KEYS = [
  "Artist/Album/01 Title.flac",
  "AC+DC/Back in Black/01 Hells Bells.mp3",
  "Simon & Garfunkel/Bookends/01 Save the Life of My Child.m4a",
  "Prince/#1s/01 When Doves Cry.flac",
  "Who?/Why?/01 What?.mp3",
  "100% Pure/50% Off/01 %41.flac",
  "Guns N' Roses/Appetite/01 It's So Easy.flac",
  "Björk/Homogenic/01 Hunter.flac",
  "坂本龍一/音楽図鑑/01 Tibetan Dance.flac",
  "Sigur Rós/( )/01 Untitled #1 (Vaka).flac",
  "Emoji 🎵/~tilde~/a!b*c(d)e.lrc",
];

afterEach(() => {
  vi.restoreAllMocks();
});

/** What the oracle computes for a presigned URL, from the URL's own parameters. */
async function oracleFor(presigned: PresignedUpload, key: string, size: number) {
  const url = new URL(presigned.url);
  const query = Object.fromEntries(
    [...url.searchParams].filter(([name]) => name !== "X-Amz-Signature"),
  );
  const headers: Record<string, string> = {
    "content-length": String(size),
    "content-type": presigned.headers["Content-Type"] ?? "",
  };
  if (presigned.headers["If-None-Match"] !== undefined) {
    headers["if-none-match"] = presigned.headers["If-None-Match"];
  }

  return oracleSignature({
    method: "PUT",
    host: `${CONFIG.accountId}.r2.cloudflarestorage.com`,
    canonicalPath: canonicalObjectPath(CONFIG.bucket, key),
    query,
    headers,
    secretAccessKey: CONFIG.secretAccessKey,
    amzDate: AMZ_DATE,
    region: "auto",
    service: "s3",
  });
}

describe("the SigV4 oracle", () => {
  it("computes AWS's worked example of a presigned GET", async () => {
    // S3 API Reference, "Authenticating Requests: Using Query Parameters
    // (AWS Signature Version 4)", the example's own values and signature.
    const signature = await oracleSignature({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      canonicalPath: "/test.txt",
      query: {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
        "X-Amz-Date": "20130524T000000Z",
        "X-Amz-Expires": "86400",
        "X-Amz-SignedHeaders": "host",
      },
      headers: {},
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      amzDate: "20130524T000000Z",
      region: "us-east-1",
      service: "s3",
    });

    expect(signature).toBe("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });

  it("computes AWS's worked example of a header-signed GET", async () => {
    // S3 API Reference, "Signature Calculations for the Authorization
    // Header: Transferring Payload in a Single Chunk", the GET Object example.
    const signature = await oracleSignature({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      canonicalPath: "/test.txt",
      query: {},
      headers: {
        range: "bytes=0-9",
        "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "x-amz-date": "20130524T000000Z",
      },
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      amzDate: "20130524T000000Z",
      region: "us-east-1",
      service: "s3",
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });

    expect(signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  it("encodes every byte but the unreserved characters", () => {
    expect(uriEncode("a b+c&d#e?f%g'h/é~-._")).toBe("a%20b%2Bc%26d%23e%3Ff%25g%27h%2F%C3%A9~-._");
  });
});

describe("presignUpload", () => {
  it.each(KEYS)("signs %s as the oracle does", async (key) => {
    for (const replace of [false, true]) {
      const presigned = await presign(
        CONFIG,
        { key, size: 41_234_567, contentType: "audio/flac", replace },
        NOW,
      );
      const url = new URL(presigned.url);

      expect(url.origin).toBe(`https://${CONFIG.accountId}.r2.cloudflarestorage.com`);
      // The path the URL carries is the canonical path itself.
      expect(url.pathname).toBe(canonicalObjectPath(CONFIG.bucket, key));
      expect(url.searchParams.get("X-Amz-Signature")).toBe(
        await oracleFor(presigned, key, 41_234_567),
      );
    }
  });

  it("binds the size, the type and, unless replacing, If-None-Match: *", async () => {
    const created = await presign(
      CONFIG,
      { key: "A/b.lrc", size: 512, contentType: "text/plain", replace: false },
      NOW,
    );
    const replaced = await presign(
      CONFIG,
      { key: "A/b.lrc", size: 512, contentType: "text/plain", replace: true },
      NOW,
    );

    expect(new URL(created.url).searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-type;host;if-none-match",
    );
    expect(created.headers).toEqual({ "Content-Type": "text/plain", "If-None-Match": "*" });
    expect(created.method).toBe("PUT");

    expect(new URL(replaced.url).searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-type;host",
    );
    expect(replaced.headers).toEqual({ "Content-Type": "text/plain" });

    // Another size or type is another signature: the URL takes only these.
    const larger = await presign(
      CONFIG,
      { key: "A/b.lrc", size: 513, contentType: "text/plain", replace: false },
      NOW,
    );
    const otherType = await presign(
      CONFIG,
      { key: "A/b.lrc", size: 512, contentType: "audio/flac", replace: false },
      NOW,
    );
    const signatures = [created, larger, otherType].map((presigned) =>
      new URL(presigned.url).searchParams.get("X-Amz-Signature"),
    );
    expect(new Set(signatures).size).toBe(3);
  });

  it("expires in 300 seconds, and expiresAt agrees with X-Amz-Date and X-Amz-Expires", async () => {
    const presigned = await presign(
      CONFIG,
      { key: "A/b.mp3", size: 1, contentType: "audio/mpeg", replace: false },
      NOW,
    );
    const query = new URL(presigned.url).searchParams;

    expect(UPLOAD_URL_TTL_SECONDS).toBe(300);
    expect(query.get("X-Amz-Expires")).toBe("300");
    expect(query.get("X-Amz-Date")).toBe(AMZ_DATE);
    expect(presigned.expiresAt).toBe("2026-10-02T12:39:56.000Z");
    expect(Date.parse(presigned.expiresAt) - Date.UTC(2026, 9, 2, 12, 34, 56)).toBe(300_000);
  });

  it("carries exactly SigV4's query parameters, with the credential's scope", async () => {
    const presigned = await presign(
      CONFIG,
      { key: "A/b.mp3", size: 1, contentType: "audio/mpeg", replace: false },
      NOW,
    );
    const query = new URL(presigned.url).searchParams;

    expect([...query.keys()].sort()).toEqual([
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-Signature",
      "X-Amz-SignedHeaders",
    ]);
    expect(query.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(query.get("X-Amz-Credential")).toBe(
      `${CONFIG.accessKeyId}/20261002/auto/s3/aws4_request`,
    );
  });

  it("never puts the secret in the URL, the answer or a log line", async () => {
    const logged: unknown[][] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }

    const presigned = await presign(
      CONFIG,
      { key: "A/b.mp3", size: 1, contentType: "audio/mpeg", replace: false },
      NOW,
    );

    const answer = JSON.stringify(presigned);
    for (const form of [
      CONFIG.secretAccessKey,
      encodeURIComponent(CONFIG.secretAccessKey),
      uriEncode(CONFIG.secretAccessKey),
    ]) {
      expect(answer).not.toContain(form);
      expect(presigned.url).not.toContain(form);
    }
    expect(JSON.stringify(logged)).not.toContain(CONFIG.secretAccessKey);
  });

  it("signs with the new secret when only the secret changes", async () => {
    // The isolate's client, and its cached signing key, must not outlive
    // the secret they were derived from.
    const upload = { key: "A/b.mp3", size: 1, contentType: "audio/mpeg", replace: false };
    const before = await presign(CONFIG, upload, NOW);
    const rotated = { ...CONFIG, secretAccessKey: "rotated-secret-only" };
    const after = await presign(rotated, upload, NOW);
    const query = new URL(after.url).searchParams;

    expect(query.get("X-Amz-Credential")).toBe(
      new URL(before.url).searchParams.get("X-Amz-Credential"),
    );
    expect(query.get("X-Amz-Signature")).not.toBe(
      new URL(before.url).searchParams.get("X-Amz-Signature"),
    );
    expect(query.get("X-Amz-Signature")).toBe(
      await oracleSignature({
        method: "PUT",
        host: `${CONFIG.accountId}.r2.cloudflarestorage.com`,
        canonicalPath: "/navidrome/A/b.mp3",
        query: Object.fromEntries([...query].filter(([name]) => name !== "X-Amz-Signature")),
        headers: { "content-length": "1", "content-type": "audio/mpeg", "if-none-match": "*" },
        secretAccessKey: "rotated-secret-only",
        amzDate: AMZ_DATE,
        region: "auto",
        service: "s3",
      }),
    );
  });

  it("signs with the new token once it changes", async () => {
    const rotated = { ...CONFIG, accessKeyId: "rotated-key-id", secretAccessKey: "rotated-secret" };
    const upload = { key: "A/b.mp3", size: 1, contentType: "audio/mpeg", replace: false };
    const before = await presign(CONFIG, upload, NOW);
    const after = await presign(rotated, upload, NOW);
    const query = new URL(after.url).searchParams;

    expect(query.get("X-Amz-Credential")).toBe("rotated-key-id/20261002/auto/s3/aws4_request");
    expect(query.get("X-Amz-Signature")).not.toBe(
      new URL(before.url).searchParams.get("X-Amz-Signature"),
    );
    expect(query.get("X-Amz-Signature")).toBe(
      await oracleSignature({
        method: "PUT",
        host: `${CONFIG.accountId}.r2.cloudflarestorage.com`,
        canonicalPath: "/navidrome/A/b.mp3",
        query: Object.fromEntries([...query].filter(([name]) => name !== "X-Amz-Signature")),
        headers: { "content-length": "1", "content-type": "audio/mpeg", "if-none-match": "*" },
        secretAccessKey: "rotated-secret",
        amzDate: AMZ_DATE,
        region: "auto",
        service: "s3",
      }),
    );
  });
});

describe("objectUrl", () => {
  it("is path-style on the account's S3 endpoint, each segment encoded", () => {
    const bucket = { endpoint: r2Endpoint(CONFIG.accountId), bucket: CONFIG.bucket };
    expect(objectUrl(bucket, "AC+DC/It's 100%/a b.flac").href).toBe(
      "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/navidrome/AC%2BDC/It%27s%20100%25/a%20b.flac",
    );
    expect(bucketUrl(bucket).href).toBe(
      "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/navidrome",
    );
    expect(encodeSegment("!'()*")).toBe("%21%27%28%29%2A");
  });

  it("refuses a key with a dot segment, which the URL parser would collapse", () => {
    const bucket = { endpoint: r2Endpoint(CONFIG.accountId), bucket: CONFIG.bucket };
    for (const key of ["a/../b.flac", "a/./b.flac", "..", "a/%2e%2E/b", "a/.%2e/b", "%2E/b"]) {
      expect(isAddressableKey(key)).toBe(false);
      expect(() => objectUrl(bucket, key)).toThrow(UnaddressableKeyError);
    }
    // A dot inside a segment, or three dots, is an ordinary name.
    for (const key of ["a/.../b", "a/..b/c", "a/b./c", ".hidden/x", "a/%2e%2e%2e/b"]) {
      expect(isAddressableKey(key)).toBe(true);
      expect(objectUrl(bucket, key).pathname).toBe(canonicalObjectPath(CONFIG.bucket, key));
    }
  });
});

describe("awsClientFor", () => {
  it("keeps one client per library, rebuilt when its token changes", () => {
    const token = { accessKeyId: "id-a", secretAccessKey: "secret-a" };
    const first = awsClientFor(71, token);

    expect(awsClientFor(71, { ...token })).toBe(first);
    expect(awsClientFor(72, token)).not.toBe(first);
    expect(awsClientFor(71, { ...token, secretAccessKey: "secret-b" })).not.toBe(first);
  });

  it("signs another library's uploads for its own endpoint and bucket", async () => {
    const endpoint = r2Endpoint("fedcba9876543210fedcba9876543210");
    const presigned = await presignUpload(
      {
        libraryId: 2,
        endpoint,
        bucket: "archive",
        credentials: { accessKeyId: "library-2-key", secretAccessKey: "library-2-secret" },
      },
      { key: "A/b.mp3", size: 1, contentType: "audio/mpeg", replace: false },
      NOW,
    );
    const url = new URL(presigned.url);

    expect(url.origin).toBe(endpoint);
    expect(url.pathname).toBe("/archive/A/b.mp3");
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      await oracleSignature({
        method: "PUT",
        host: url.host,
        canonicalPath: "/archive/A/b.mp3",
        query: Object.fromEntries([...url.searchParams].filter(([n]) => n !== "X-Amz-Signature")),
        headers: { "content-length": "1", "content-type": "audio/mpeg", "if-none-match": "*" },
        secretAccessKey: "library-2-secret",
        amzDate: AMZ_DATE,
        region: "auto",
        service: "s3",
      }),
    );
  });
});
