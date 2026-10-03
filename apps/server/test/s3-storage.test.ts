import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { bindingStorage } from "../src/storage/binding";
import { sealCredentials } from "../src/storage/credentials";
import { type StorageRow, storageFor } from "../src/storage/for-library";
import {
  type CredentialsSource,
  deleteRequests,
  failureReason,
  R2_ENDPOINT,
  s3Storage,
} from "../src/storage/s3";
import {
  type LibraryStorage,
  StorageError,
  type StorageFailure,
  UnaddressableKeyError,
} from "../src/storage/storage";
import { FakeS3, type FakeS3Failure, installFakeS3, libraryTestBucket } from "./fake-s3";
import { encryptionKey, testEnv } from "./support";

/**
 * What only the S3 client does (storage/s3.ts; #84, "Storage interface" and
 * "Testing Decisions"), against the fake R2 (test/fake-s3.ts): the failure
 * reasons, the requests it makes and refuses to make, and `storageFor`. What
 * every storage does is the contract's (test/storage-contract.test.ts).
 */

const encoder = new TextEncoder();

let fake: FakeS3;
let fetchSpy: MockInstance<typeof fetch>;
let runs = 0;
/** A prefix of this test's own in the fake's bucket. */
let prefix: string;

beforeEach(() => {
  fake = new FakeS3();
  fetchSpy = installFakeS3(fake);
  prefix = `s3-storage/${++runs}/`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function storage(credentials: CredentialsSource = fake.credentials()): LibraryStorage {
  return s3Storage(fake.location(), credentials);
}

/** The reason a call failed with, or a failure of the test if it did not. */
async function reasonOf(call: Promise<unknown>): Promise<StorageFailure> {
  try {
    await call;
  } catch (error) {
    if (error instanceof StorageError) {
      return error.reason;
    }
    throw error;
  }
  throw new Error("the call did not fail");
}

describe("s3Storage", () => {
  it("is the library it was made for", () => {
    expect(s3Storage(fake.location(7), fake.credentials()).libraryId).toBe(7);
  });

  it("answers the same etag as the binding for the same bytes", async () => {
    const bytes = encoder.encode("the same bytes in two buckets");
    const viaBinding = await bindingStorage(testEnv).put(`${prefix}same`, bytes);
    const viaS3 = await storage().put(`${prefix}same`, bytes);

    expect(viaS3?.etag).toBe(viaBinding?.etag);
    expect((await storage().head(`${prefix}same`))?.etag).toBe(viaBinding?.etag);
  });

  it("makes one request an operation, and sends each with redirect: manual", async () => {
    const s3 = storage();
    const key = `${prefix}ten`;
    await s3.put(key, encoder.encode("0123456789"), { contentType: "audio/flac" });
    await s3.head(key);
    await (await s3.get(key))?.cancel();
    await (await s3.get(key, { offset: 2, length: 3 }))?.cancel();
    await s3.list({ prefix, delimiter: "/", limit: 10 });
    await s3.delete([key]);

    expect(fake.calls.map((call) => call.operation)).toEqual([
      "PutObject",
      "HeadObject",
      "GetObject",
      "GetObject",
      "ListObjectsV2",
      "DeleteObjects",
    ]);
    expect(fake.calls.every((call) => call.signatureValid)).toBe(true);
    for (const [input] of fetchSpy.mock.calls) {
      expect((input as Request).redirect).toBe("manual");
      expect((input as Request).headers.get("X-Amz-Content-Sha256")).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("lists with list-type=2, encoding-type=url and each option given", async () => {
    await storage().list({ prefix: `${prefix}a b+c/`, delimiter: "/", limit: 7 });
    const listed = new URL(fake.calls[0]?.url ?? "");

    expect(listed.pathname).toBe(`/${fake.bucket}`);
    expect(Object.fromEntries(listed.searchParams)).toEqual({
      "list-type": "2",
      "encoding-type": "url",
      "max-keys": "7",
      prefix: `${prefix}a b+c/`,
      delimiter: "/",
    });
    // A space goes as `%20`, as signed, never as a `+`.
    expect(listed.search).toContain("a%20b%2Bc");
  });

  it("reads the size of a ranged read from Content-Range", async () => {
    const key = `${prefix}size`;
    await libraryTestBucket().put(key, encoder.encode("0123456789abcdef"));

    const part = await storage().get(key, { offset: 4, length: 4 });

    expect(part?.size).toBe(16);
    expect(new TextDecoder().decode(await part?.bytes())).toBe("4567");
    expect(fake.calls.map((call) => call.operation)).toEqual(["GetObject"]);
  });

  it("asks for the object's size only for a range at or past its end", async () => {
    const key = `${prefix}short`;
    await libraryTestBucket().put(key, encoder.encode("0123"));

    const past = await storage().get(key, { offset: 9, length: 4 });

    expect(past?.size).toBe(4);
    expect(await past?.bytes()).toEqual(new Uint8Array(0));
    expect(fake.calls.map((call) => [call.operation, call.status])).toEqual([
      ["GetObject", 416],
      ["HeadObject", 200],
    ]);
  });

  it("deletes a thousand keys a call, and each control-character key alone", async () => {
    const plain = Array.from({ length: 1001 }, (_, index) => `${prefix}${index}`);
    const awkward = [`${prefix}bell\u0007.flac`, `${prefix}tab\there.flac`];
    for (const key of [...plain.slice(0, 3), ...awkward]) {
      await libraryTestBucket().put(key, encoder.encode("x"));
    }
    const keys = [plain[0] ?? "", awkward[0] ?? "", ...plain.slice(1), awkward[1] ?? ""];

    await storage().delete(keys);

    expect(fake.deleteCalls()).toEqual([1000, 1]);
    expect(
      fake.calls.filter((call) => call.operation === "DeleteObject").map((call) => call.key),
    ).toEqual(awkward);
    expect(fake.calls).toHaveLength(deleteRequests(keys));
    expect((await libraryTestBucket().list({ prefix })).objects).toEqual([]);
  });

  it("deletes a key holding U+FFFE or U+FFFF alone, as XML 1.0 cannot carry it", async () => {
    const awkward = [`${prefix}not￾a-character`, `${prefix}nor￿this`];
    for (const key of awkward) {
      await libraryTestBucket().put(key, encoder.encode("x"));
    }

    await storage().delete([`${prefix}plain`, ...awkward]);

    expect(fake.deleteCalls()).toEqual([1]);
    expect(
      fake.calls.filter((call) => call.operation === "DeleteObject").map((call) => call.key),
    ).toEqual(awkward);
    expect((await libraryTestBucket().list({ prefix })).objects).toEqual([]);
  });

  it("refuses to delete a key with a lone surrogate, which neither XML nor a URL carries", async () => {
    await expect(storage().delete([`${prefix}ok`, `${prefix}lone\ud800`])).rejects.toThrow(
      UnaddressableKeyError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("deletes a key with a dot segment in a DeleteObjects body, which no URL carries", async () => {
    const key = `${prefix}a/../b.flac`;
    await libraryTestBucket().put(key, encoder.encode("x"));

    await storage().delete([key]);

    expect(await libraryTestBucket().head(key)).toBeNull();
    expect(fake.deleteCalls()).toEqual([1]);
  });

  it("refuses a key with a dot segment before making any request", async () => {
    const s3 = storage();
    const key = `${prefix}a/../b.flac`;
    const upload = { key, size: 1, contentType: "audio/flac", replace: false };

    await expect(s3.head(key)).rejects.toThrow(UnaddressableKeyError);
    await expect(s3.get(key)).rejects.toThrow(UnaddressableKeyError);
    await expect(s3.get(key, { offset: 0, length: 4 })).rejects.toThrow(UnaddressableKeyError);
    await expect(s3.put(key, new Uint8Array(1))).rejects.toThrow(UnaddressableKeyError);
    await expect(s3.presignPut(upload)).rejects.toThrow(UnaddressableKeyError);
    // Alone (a control character), it would need a URL: nothing is deleted.
    await expect(s3.delete([`${prefix}ok`, `${prefix}..\u0001/../x`])).rejects.toThrow(
      UnaddressableKeyError,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads and writes a key with %2e segments, which are names, not dot segments", async () => {
    const s3 = storage();
    for (const name of ["%2e%2e/x.mp3", "a/%2E/x.mp3", "b/.%2e/y"]) {
      const key = `${prefix}${name}`;
      expect((await s3.put(key, encoder.encode(name)))?.key).toBe(key);
      expect((await s3.head(key))?.size).toBe(name.length);
      expect(new TextDecoder().decode(await (await s3.get(key))?.bytes())).toBe(name);
      expect(await libraryTestBucket().head(key)).not.toBeNull();
    }
    const listed = (await s3.list({ prefix, limit: 10 })).objects.map((object) => object.key);
    expect(listed.sort()).toEqual(
      ["%2e%2e/x.mp3", "a/%2E/x.mp3", "b/.%2e/y"].map((name) => `${prefix}${name}`).sort(),
    );
    expect(fake.calls.every((call) => call.signatureValid)).toBe(true);
  });

  it.each([
    ["http://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"],
    ["https://0123456789ABCDEF0123456789ABCDEF.r2.cloudflarestorage.com"],
    ["https://0123456789abcdef0123456789abcde.r2.cloudflarestorage.com"],
    ["https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/"],
    ["https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com.evil.example"],
    ["https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com"],
    ["https://evil.example/0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"],
    ["https://user@0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"],
    [""],
  ])("refuses the endpoint %j before opening the token or sending", async (endpoint) => {
    const open = vi.fn(async () => fake.credentials());
    const s3 = s3Storage({ libraryId: 2, endpoint, bucket: fake.bucket }, open);
    const upload = { key: "a.flac", size: 1, contentType: "audio/flac", replace: false };

    expect(R2_ENDPOINT.test(endpoint)).toBe(false);
    for (const call of [
      s3.list({ limit: 1 }),
      s3.head("a.flac"),
      s3.get("a.flac"),
      s3.put("a.flac", new Uint8Array(1)),
      s3.delete(["a.flac"]),
      s3.presignPut(upload),
    ]) {
      expect(await reasonOf(call)).toBe("unavailable");
    }
    expect(open).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a bucket that is not an R2 bucket name", async () => {
    for (const bucket of ["..", "a", "Upper", "under_score", "-dash", "a/b", ""]) {
      const s3 = s3Storage({ libraryId: 2, endpoint: fake.endpoint, bucket }, fake.credentials());
      expect(await reasonOf(s3.list({ limit: 1 }))).toBe("unavailable");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("s3Storage failures", () => {
  const injected: [FakeS3Failure, StorageFailure][] = [
    ["access_denied", "auth"],
    ["unauthorized", "auth"],
    ["no_such_bucket", "bucket_not_found"],
    ["slow_down", "throttled"],
    ["too_many_requests", "throttled"],
    ["server_error", "unavailable"],
    ["redirect", "unavailable"],
    ["network", "unavailable"],
  ];

  it.each(injected)("reads %s as %s on a listing, a read and a write", async (failure, reason) => {
    const s3 = storage();
    fake.fail(failure);

    expect(await reasonOf(s3.list({ prefix, limit: 10 }))).toBe(reason);
    expect(await reasonOf(s3.get(`${prefix}a`))).toBe(reason);
    expect(await reasonOf(s3.get(`${prefix}a`, { offset: 0, length: 2 }))).toBe(reason);
    expect(await reasonOf(s3.put(`${prefix}a`, new Uint8Array(1)))).toBe(reason);
    expect(await reasonOf(s3.delete([`${prefix}a`]))).toBe(reason);
    expect(await reasonOf(s3.delete([`${prefix}control\u0001`]))).toBe(reason);
    // A redirect is not followed: one request each.
    expect(fake.calls).toHaveLength(6);
  });

  it("reads a HEAD's bodiless answers by their status alone", async () => {
    const s3 = storage();
    const cases: [FakeS3Failure, StorageFailure | null][] = [
      ["access_denied", "auth"],
      ["unauthorized", "auth"],
      // A HEAD cannot tell a missing bucket from a missing key.
      ["no_such_bucket", null],
      ["too_many_requests", "throttled"],
      // A 503 with no code to say SlowDown.
      ["slow_down", "unavailable"],
      ["server_error", "unavailable"],
      ["redirect", "unavailable"],
      ["network", "unavailable"],
    ];
    for (const [failure, reason] of cases) {
      fake.fail(failure);
      if (reason === null) {
        expect(await s3.head(`${prefix}a`)).toBeNull();
      } else {
        expect(await reasonOf(s3.head(`${prefix}a`))).toBe(reason);
      }
    }
  });

  it("reads a bucket that does not exist as bucket_not_found", async () => {
    const s3 = s3Storage({ ...fake.location(), bucket: "no-such-bucket" }, fake.credentials());

    expect(await reasonOf(s3.list({ limit: 1 }))).toBe("bucket_not_found");
    expect(await reasonOf(s3.get("a"))).toBe("bucket_not_found");
  });

  it("reads a refused signature or an unknown key as auth", async () => {
    const wrongSecret = storage({ ...fake.credentials(), secretAccessKey: "not-the-secret" });
    const unknownKey = storage({ ...fake.credentials(), accessKeyId: "not-the-key" });

    expect(await reasonOf(wrongSecret.list({ limit: 1 }))).toBe("auth");
    expect(await reasonOf(unknownKey.list({ limit: 1 }))).toBe("auth");
    expect(await reasonOf(wrongSecret.head("a"))).toBe("auth");
  });

  it("reads a continuation token the bucket refuses as invalid_cursor", async () => {
    const s3 = storage();

    expect(await reasonOf(s3.list({ limit: 10, cursor: "never-issued" }))).toBe("invalid_cursor");
    expect(fake.calls.map((call) => call.status)).toEqual([400]);
  });

  it.each<[FakeS3Failure, string]>([
    ["wrong_range", "starts elsewhere"],
    ["long_range", "runs past the bytes asked for"],
  ])("refuses a ranged read whose range (%s) %s", async (failure, _what) => {
    const key = `${prefix}range`;
    await libraryTestBucket().put(key, encoder.encode("0123456789"));
    fake.fail(failure);

    expect(await reasonOf(storage().get(key, { offset: 2, length: 3 }))).toBe("unavailable");
    expect(fake.calls.map((call) => [call.operation, call.status])).toEqual([["GetObject", 206]]);
    // A range clamped at the object's end is still the one asked for.
    fake.fail(null);
    expect((await storage().get(key, { offset: 8, length: 5 }))?.size).toBe(10);
  });

  it("reads a key DeleteObjects did not delete as a failure", async () => {
    fake.fail("delete_error");

    expect(await reasonOf(storage().delete([`${prefix}a`, `${prefix}b`]))).toBe("auth");
  });

  it("reads a token that does not open as auth, before sending", async () => {
    const s3 = storage(() => Promise.reject(new Error("does not open")));

    expect(await reasonOf(s3.list({ limit: 1 }))).toBe("auth");
    expect(
      await reasonOf(
        s3.presignPut({ key: "a.flac", size: 1, contentType: "audio/flac", replace: false }),
      ),
    ).toBe("auth");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["an HTML page", "<html><body>Bad gateway</body></html>"],
    ["an empty body", ""],
    ["a listing without IsTruncated", "<ListBucketResult></ListBucketResult>"],
    ["a cut-off listing", "<ListBucketResult><IsTruncated>false</IsTruncated>"],
  ])("reads %s answered 200 to a listing as unavailable", async (_, body) => {
    fetchSpy.mockImplementation(async () => new Response(body, { status: 200 }));

    expect(await reasonOf(storage().list({ limit: 1 }))).toBe("unavailable");
  });

  it("maps each status and code as #84 and R2's error codes say", () => {
    expect(failureReason(401, "Unauthorized")).toBe("auth");
    expect(failureReason(403, "AccessDenied")).toBe("auth");
    expect(failureReason(403, "InvalidAccessKeyId")).toBe("auth");
    expect(failureReason(403, "SignatureDoesNotMatch")).toBe("auth");
    expect(failureReason(403, null)).toBe("auth");
    expect(failureReason(403, "RequestTimeTooSkewed")).toBe("unavailable");
    expect(failureReason(404, "NoSuchBucket")).toBe("bucket_not_found");
    expect(failureReason(429, "TooManyRequests")).toBe("throttled");
    expect(failureReason(503, "SlowDown")).toBe("throttled");
    expect(failureReason(503, "ServiceUnavailable")).toBe("unavailable");
    expect(failureReason(400, "InvalidArgument", true)).toBe("invalid_cursor");
    expect(failureReason(400, "InvalidArgument", false)).toBe("unavailable");
    expect(failureReason(400, "MalformedXML", true)).toBe("unavailable");
    expect(failureReason(500, "InternalError")).toBe("unavailable");
    expect(failureReason(409, null)).toBe("unavailable");
  });
});

describe("deleteRequests", () => {
  it("counts a request a thousand keys, and one for each key alone", () => {
    expect(deleteRequests([])).toBe(0);
    expect(deleteRequests(["a"])).toBe(1);
    expect(deleteRequests(Array.from({ length: 1000 }, (_, i) => `${i}`))).toBe(1);
    expect(deleteRequests(Array.from({ length: 1001 }, (_, i) => `${i}`))).toBe(2);
    expect(deleteRequests(["a", "b\u0000", "c\u001f", "d\u007f"])).toBe(3);
    expect(deleteRequests(["a", "b￾", "c￿", "d�"])).toBe(3);
  });
});

describe("storageFor", () => {
  const path = () => `s3://${fake.host}/${fake.bucket}`;

  function row(overrides: Partial<StorageRow> = {}): StorageRow {
    return {
      id: 2,
      kind: "s3",
      path: path(),
      endpoint: fake.endpoint,
      bucket: fake.bucket,
      credentials: null,
      ...overrides,
    };
  }

  it("is the binding for library 1, and refuses another library claiming it", () => {
    const bound = storageFor(
      testEnv,
      row({ id: 1, kind: "r2-binding", path: "r2-binding://MUSIC" }),
    );

    expect(bound.libraryId).toBe(1);
    expect(() => storageFor(testEnv, row({ kind: "r2-binding" }))).toThrow(/only library 1/);
  });

  it("reaches an S3 library with its sealed token, opened on first use", async () => {
    const sealed = await sealCredentials(encryptionKey(), path(), fake.credentials());
    const library = storageFor(testEnv, row({ credentials: sealed }));
    const key = `${prefix}sealed.flac`;

    expect(library.libraryId).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    await library.put(key, encoder.encode("x"));
    expect((await library.head(key))?.size).toBe(1);
    expect(fake.calls.every((call) => call.signatureValid)).toBe(true);
  });

  it("refuses a row whose endpoint or bucket its path does not name, before opening or sending", async () => {
    // A valid token, sealed for this row's path, aimed elsewhere by a
    // tampered endpoint or bucket: the AAD binds only the path.
    const sealed = await sealCredentials(encryptionKey(), path(), fake.credentials());
    const other = new FakeS3({ accountId: "0123456789abcdef0123456789abcdef" });
    for (const tampered of [
      row({ credentials: sealed, endpoint: other.endpoint }),
      row({ credentials: sealed, bucket: "another-bucket" }),
      row({ credentials: sealed, path: `${path()}x` }),
    ]) {
      expect(await reasonOf(storageFor(testEnv, tampered).list({ limit: 1 }))).toBe("unavailable");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reads a token sealed for another path, or none, as auth, before sending", async () => {
    const elsewhere = await sealCredentials(
      encryptionKey(),
      "s3://other/bucket",
      fake.credentials(),
    );

    expect(await reasonOf(storageFor(testEnv, row({ credentials: elsewhere })).head("a"))).toBe(
      "auth",
    );
    expect(await reasonOf(storageFor(testEnv, row()).head("a"))).toBe("auth");
    expect(
      await reasonOf(
        storageFor(
          { ...testEnv, PASSWORD_ENCRYPTION_KEY: "rotated" },
          row({
            credentials: await sealCredentials(encryptionKey(), path(), fake.credentials()),
          }),
        ).list({ limit: 1 }),
      ),
    ).toBe("auth");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
