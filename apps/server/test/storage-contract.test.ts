import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { BOUND_LIBRARY_ID, bindingStorage, boundStorage } from "../src/storage/binding";
import type { PresignedUpload } from "../src/storage/presign";
import { s3Storage } from "../src/storage/s3";
import type { LibraryStorage, StoredObject } from "../src/storage/storage";
import { FakeS3, installFakeS3 } from "./fake-s3";
import { canonicalObjectPath, oracleSignature } from "./sigv4-oracle";
import { testEnv } from "./support";

/**
 * The storage contract (#84, "Testing Decisions"): what every
 * `LibraryStorage` promises, written once and run against each
 * implementation: the binding (`bindingStorage`), and the S3 client
 * (`s3Storage`) against the fake S3 (test/fake-s3.ts). What only the S3
 * client does is tested in s3-storage.test.ts.
 *
 * Each test works under a prefix of its own, so the tests share the bucket
 * without seeing one another's keys.
 */

/** An implementation under test, and what the contract needs to know of it. */
interface ContractSubject {
  /** The storage, over a bucket the tests may write to. */
  readonly storage: () => LibraryStorage;
  /** The same bucket with uploads configured, and what its URLs are signed for. */
  readonly uploads: {
    readonly storage: () => LibraryStorage;
    readonly host: string;
    readonly bucket: string;
    readonly secretAccessKey: string;
  };
  /** The same bucket with uploads not configured, when it has such a form. */
  readonly unconfigured?: () => LibraryStorage;
  /** How many keys each bulk delete call so far carried, when it can be counted. */
  readonly deleteCalls?: () => readonly number[];
  /**
   * How closely a `put`'s `uploaded` matches the listing's: to the
   * millisecond (the default), or within the second, as over the S3 API,
   * where `PutObject` answers no `Last-Modified` and a listing is the
   * authority (storage/storage.ts, `StoredObject.uploaded`).
   */
  readonly uploadedPrecision?: "millisecond" | "second";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Keys with every character a bucket, a URL or an XML body can get wrong. */
const AWKWARD_NAMES = [
  "with space/01 a title.flac",
  "AC+DC & Friends/#1 100% 'Live'.mp3",
  "Björk/Jóga.flac",
  "坂本龍一/音楽図鑑/01 Tibetan Dance.flac",
  "Emoji 🎵/~tilde~/a!b*c(d)e.lrc",
  "control\u0001character.flac",
];

/** 2026-10-02 12:34:56 UTC, as an `X-Amz-Date`. */
const NOW = Date.UTC(2026, 9, 2, 12, 34, 56);
const AMZ_DATE = "20261002T123456Z";

function storageContract(name: string, subject: ContractSubject): void {
  describe(`the storage contract: ${name}`, () => {
    let runs = 0;
    /** A prefix no other test writes under. */
    const freshPrefix = () => `contract/${name}/${++runs}/`;

    async function putAll(storage: LibraryStorage, keys: readonly string[], bytes = "x") {
      for (let start = 0; start < keys.length; start += 50) {
        await Promise.all(
          keys.slice(start, start + 50).map((key) => storage.put(key, encoder.encode(bytes))),
        );
      }
    }

    /** Every page of a listing, in order. */
    async function allPages(
      storage: LibraryStorage,
      options: { prefix: string; delimiter?: "/"; limit: number },
    ) {
      const pages = [];
      let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const listing = await storage.list({ ...options, cursor });
        pages.push(listing);
        if (listing.cursor === null) {
          return pages;
        }
        cursor = listing.cursor;
      }
      throw new Error("the listing never ended");
    }

    async function text(
      storage: LibraryStorage,
      key: string,
      range?: Parameters<LibraryStorage["get"]>[1],
    ) {
      const body = await storage.get(key, range);
      return body === null ? null : decoder.decode(await body.bytes());
    }

    it("lists a prefix flat, and delimited into folders", async () => {
      const storage = subject.storage();
      const prefix = freshPrefix();
      const keys = ["a/1.flac", "a/2.flac", "b/c/3.flac", "top.flac"].map((key) => prefix + key);
      await putAll(storage, keys);

      const flat = await storage.list({ prefix, limit: 1000 });
      expect(flat.objects.map((object) => object.key)).toEqual(keys);
      expect(flat.prefixes).toEqual([]);
      expect(flat.cursor).toBeNull();

      const delimited = await storage.list({ prefix, delimiter: "/", limit: 1000 });
      expect(delimited.objects.map((object) => object.key)).toEqual([`${prefix}top.flac`]);
      expect(delimited.prefixes).toEqual([`${prefix}a/`, `${prefix}b/`]);
      expect(delimited.cursor).toBeNull();
    });

    it("describes each listed object", async () => {
      const storage = subject.storage();
      const prefix = freshPrefix();
      const stored = await storage.put(`${prefix}one.flac`, encoder.encode("12345"));

      const [listed] = (await storage.list({ prefix, limit: 1000 })).objects;
      expect(listed?.key).toBe(`${prefix}one.flac`);
      expect(listed?.size).toBe(5);
      expect(listed?.etag).toBe(stored?.etag);
      expect(listed?.uploaded).toBeInstanceOf(Date);
      if (subject.uploadedPrecision === "second") {
        expect(
          Math.abs((listed?.uploaded.getTime() ?? 0) - (stored?.uploaded.getTime() ?? Number.NaN)),
        ).toBeLessThan(1000);
      } else {
        expect(listed?.uploaded.getTime()).toBe(stored?.uploaded.getTime());
      }
    });

    it("pages a listing with small limits, to the last page", async () => {
      const storage = subject.storage();
      const prefix = freshPrefix();
      const keys = ["1", "2", "3", "4", "5"].map((key) => `${prefix}${key}.flac`);
      await putAll(storage, keys);

      const pages = await allPages(storage, { prefix, limit: 2 });
      expect(pages.map((page) => page.objects.length)).toEqual([2, 2, 1]);
      expect(pages.flatMap((page) => page.objects.map((object) => object.key))).toEqual(keys);
      expect(pages.slice(0, -1).every((page) => typeof page.cursor === "string")).toBe(true);
    });

    it("pages a delimited listing with small limits", async () => {
      const storage = subject.storage();
      const prefix = freshPrefix();
      await putAll(
        storage,
        ["a/1.flac", "a/2.flac", "b/1.flac", "c.flac", "d.flac"].map((key) => prefix + key),
      );

      const pages = await allPages(storage, { prefix, delimiter: "/", limit: 1 });
      expect(pages.flatMap((page) => page.prefixes)).toEqual([`${prefix}a/`, `${prefix}b/`]);
      expect(pages.flatMap((page) => page.objects.map((object) => object.key))).toEqual([
        `${prefix}c.flac`,
        `${prefix}d.flac`,
      ]);
      expect(pages.every((page) => page.objects.length + page.prefixes.length <= 1)).toBe(true);
    });

    it("keeps every key exactly as written, whatever its characters", async () => {
      const storage = subject.storage();
      const prefix = freshPrefix();
      const keys = AWKWARD_NAMES.map((name) => prefix + name);
      for (const key of keys) {
        expect((await storage.put(key, encoder.encode(key)))?.key).toBe(key);
      }

      const listed = (await storage.list({ prefix, limit: 1000 })).objects.map((o) => o.key);
      expect([...listed].sort()).toEqual([...keys].sort());
      for (const key of keys) {
        expect((await storage.head(key))?.key).toBe(key);
        expect(await text(storage, key)).toBe(key);
        expect(await text(storage, key, { offset: 0, length: prefix.length })).toBe(prefix);
      }

      await storage.delete(keys);
      expect((await storage.list({ prefix, limit: 1000 })).objects).toEqual([]);
    });

    it("answers null for a key it does not hold", async () => {
      const storage = subject.storage();
      const key = `${freshPrefix()}missing.flac`;

      expect(await storage.head(key)).toBeNull();
      expect(await storage.get(key)).toBeNull();
      expect(await storage.get(key, { offset: 0, length: 16 })).toBeNull();
      expect(await storage.get(key, { offset: 0, length: 0 })).toBeNull();
    });

    it("reads a range, clamped to the object", async () => {
      const storage = subject.storage();
      const key = `${freshPrefix()}ten`;
      await storage.put(key, encoder.encode("0123456789"));

      expect(await text(storage, key)).toBe("0123456789");
      expect(await text(storage, key, { offset: 2, length: 3 })).toBe("234");
      expect(await text(storage, key, { offset: 0, length: 10 })).toBe("0123456789");
      // Past the end: short, then empty.
      expect(await text(storage, key, { offset: 5, length: 100 })).toBe("56789");
      expect(await text(storage, key, { offset: 10, length: 5 })).toBe("");
      expect(await text(storage, key, { offset: 20, length: 5 })).toBe("");
      expect(await text(storage, key, { offset: 3, length: 0 })).toBe("");

      // A range describes the whole object, not the part read.
      const part = await storage.get(key, { offset: 2, length: 3 });
      expect(part?.size).toBe(10);
      expect(part?.etag).toBe((await storage.head(key))?.etag);
      await part?.cancel();
    });

    it("reads an empty object, whole or in part", async () => {
      const storage = subject.storage();
      const key = `${freshPrefix()}empty`;
      expect((await storage.put(key, new Uint8Array(0)))?.size).toBe(0);

      expect((await storage.head(key))?.size).toBe(0);
      expect(await text(storage, key)).toBe("");
      expect(await text(storage, key, { offset: 0, length: 5 })).toBe("");
      expect((await storage.get(key, { offset: 0, length: 5 }))?.size).toBe(0);
    });

    it("streams a body, or lets it go unread", async () => {
      const storage = subject.storage();
      const key = `${freshPrefix()}stream`;
      await storage.put(key, encoder.encode("streamed bytes"));

      const streamed = await storage.get(key, { offset: 0, length: 8 });
      expect(await new Response(streamed?.body).text()).toBe("streamed");

      const unread = await storage.get(key);
      await expect(unread?.cancel()).resolves.toBeUndefined();
    });

    it("stores a content type, and refuses to replace a key onlyIfAbsent", async () => {
      const storage = subject.storage();
      const key = `${freshPrefix()}cover.png`;

      const stored = await storage.put(key, encoder.encode("first"), { contentType: "image/png" });
      expect(stored?.key).toBe(key);
      expect(stored?.size).toBe(5);
      expect((await storage.head(key))?.contentType).toBe("image/png");
      expect((await storage.get(key))?.contentType).toBe("image/png");

      expect(await storage.put(key, encoder.encode("second"), { onlyIfAbsent: true })).toBeNull();
      expect(await text(storage, key)).toBe("first");

      const fresh = `${key}.new`;
      expect((await storage.put(fresh, encoder.encode("new"), { onlyIfAbsent: true }))?.size).toBe(
        3,
      );
      expect(await text(storage, fresh)).toBe("new");

      // Without the condition, a put replaces.
      await storage.put(key, encoder.encode("second"));
      expect(await text(storage, key)).toBe("second");
    });

    it("stores the content type of a put onlyIfAbsent", async () => {
      const storage = subject.storage();
      const key = `${freshPrefix()}cover.jpg`;

      const stored = await storage.put(key, encoder.encode("jpeg"), {
        contentType: "image/jpeg",
        onlyIfAbsent: true,
      });
      expect(stored?.size).toBe(4);
      expect((await storage.head(key))?.contentType).toBe("image/jpeg");
      expect(
        await storage.put(key, encoder.encode("png"), {
          contentType: "image/png",
          onlyIfAbsent: true,
        }),
      ).toBeNull();
      expect((await storage.head(key))?.contentType).toBe("image/jpeg");
    });

    it("refuses a range that is negative or not whole", async () => {
      const storage = subject.storage();
      const key = `${freshPrefix()}ten`;
      await storage.put(key, encoder.encode("0123456789"));

      await expect(storage.get(key, { offset: -1, length: 4 })).rejects.toThrow(RangeError);
      await expect(storage.get(key, { offset: 0, length: -4 })).rejects.toThrow(RangeError);
      await expect(storage.get(key, { offset: 1.5, length: 4 })).rejects.toThrow(RangeError);
      await expect(storage.get(key, { offset: 0, length: 2.5 })).rejects.toThrow(RangeError);
    });

    it("deletes 1,500 keys, a thousand a call, and a missing key", async () => {
      const storage = subject.storage();
      const prefix = freshPrefix();
      const keys = Array.from({ length: 1500 }, (_, index) => `${prefix}${index}`);
      await putAll(storage, keys);
      const before = subject.deleteCalls?.().length ?? 0;

      await storage.delete(keys);

      expect((await storage.list({ prefix, limit: 1000 })).objects).toEqual([]);
      if (subject.deleteCalls) {
        expect(subject.deleteCalls().slice(before)).toEqual([1000, 500]);
      }

      await expect(storage.delete([`${prefix}never-written`])).resolves.toBeUndefined();
      const calls = subject.deleteCalls?.().length;
      await storage.delete([]);
      expect(subject.deleteCalls?.().length).toBe(calls);
      // 1,500 writes first, each a signed request over the S3 API: more than
      // the default 5 s on a busy machine.
    }, 30_000);

    it("answers etags unquoted, and equal for the same bytes", async () => {
      const storage = subject.storage();
      const prefix = freshPrefix();
      const bytes = encoder.encode("the same bytes");

      const first = await storage.put(`${prefix}a`, bytes);
      const second = await storage.put(`${prefix}b`, bytes);
      const other = await storage.put(`${prefix}c`, encoder.encode("other bytes"));

      const etags: (StoredObject | null | undefined)[] = [
        first,
        await storage.head(`${prefix}a`),
        await storage.get(`${prefix}a`),
        (await storage.list({ prefix, limit: 1 })).objects[0],
      ];
      for (const object of etags) {
        expect(object?.etag).toBe(first?.etag);
      }
      expect(first?.etag).toMatch(/^[^"]+$/);
      expect(second?.etag).toBe(first?.etag);
      expect(other?.etag).not.toBe(first?.etag);
    });

    it("presigns uploads the SigV4 oracle verifies, for its own host and path", async () => {
      const { storage, host, bucket, secretAccessKey } = subject.uploads;
      for (const name of [...AWKWARD_NAMES, "Artist/Album/01 Title.flac"]) {
        for (const replace of [false, true]) {
          const size = 41_234_567;
          const presigned = await storage().presignPut(
            { key: name, size, contentType: "audio/flac", replace },
            NOW,
          );
          expect(presigned).not.toBeNull();
          const url = new URL((presigned as PresignedUpload).url);
          expect(url.host).toBe(host);
          expect(url.pathname).toBe(canonicalObjectPath(bucket, name));
          expect(url.searchParams.get("X-Amz-Signature")).toBe(
            await oracleFor(
              presigned as PresignedUpload,
              { host, bucket, secretAccessKey },
              name,
              size,
            ),
          );
          expect("If-None-Match" in (presigned as PresignedUpload).headers).toBe(!replace);
        }
      }
    });

    it.skipIf(subject.unconfigured === undefined)(
      "presigns nothing where uploads are not configured",
      async () => {
        const unconfigured = subject.unconfigured?.();
        expect(
          await unconfigured?.presignPut(
            { key: "a.flac", size: 1, contentType: "audio/flac", replace: false },
            NOW,
          ),
        ).toBeNull();
      },
    );
  });
}

/** What the oracle computes for a presigned URL, from the URL's own parameters. */
function oracleFor(
  presigned: PresignedUpload,
  target: { readonly host: string; readonly bucket: string; readonly secretAccessKey: string },
  key: string,
  size: number,
): Promise<string> {
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
    host: target.host,
    canonicalPath: canonicalObjectPath(target.bucket, key),
    query,
    headers,
    secretAccessKey: target.secretAccessKey,
    amzDate: AMZ_DATE,
    region: "auto",
    service: "s3",
  });
}

/* ------------------------------------------------------------ binding -- */

/** How many keys each `MUSIC.delete` call carried. */
const bindingDeletes: number[] = [];

/** The test bucket, with its bulk deletes counted. */
const countedMusic = new Proxy(testEnv.MUSIC, {
  get(target, property) {
    const value = Reflect.get(target, property);
    if (typeof value !== "function") {
      return value;
    }
    if (property === "delete") {
      return (keys: string | string[]) => {
        bindingDeletes.push([keys].flat().length);
        return target.delete(keys);
      };
    }
    return value.bind(target);
  },
});

const UPLOADS = {
  R2_ACCESS_KEY_ID: "contract-access-key-id",
  R2_SECRET_ACCESS_KEY: "contract+secret/access=key-not-real",
  CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_BUCKET_NAME: "navidrome",
};

storageContract("the R2 binding", {
  storage: () => bindingStorage({ ...testEnv, MUSIC: countedMusic }),
  uploads: {
    storage: () => bindingStorage({ ...testEnv, ...UPLOADS } as Env),
    host: `${UPLOADS.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    bucket: UPLOADS.R2_BUCKET_NAME,
    secretAccessKey: UPLOADS.R2_SECRET_ACCESS_KEY,
  },
  // The pinned environment leaves the token unset.
  unconfigured: () => bindingStorage(testEnv),
  deleteCalls: () => bindingDeletes,
});

/* ----------------------------------------------------------------- S3 -- */

describe("over the S3 API", () => {
  const fake = new FakeS3();
  let restore: () => void = () => {};
  beforeAll(() => {
    const spy = installFakeS3(fake);
    restore = () => spy.mockRestore();
  });
  afterAll(() => restore());

  const storage = () => s3Storage(fake.location(), fake.credentials());

  storageContract("the S3 API, on a fake R2", {
    storage,
    uploads: {
      storage,
      host: fake.host,
      bucket: fake.bucket,
      secretAccessKey: fake.secretAccessKey,
    },
    // A connected library always has its token, so its uploads are always
    // configured.
    deleteCalls: () => fake.deleteCalls(),
    uploadedPrecision: "second",
  });

  it("signed every request the contract made, as the oracle verifies", () => {
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls.filter((call) => !call.signatureValid)).toEqual([]);
  });
});

describe("bindingStorage", () => {
  it("is library 1, the bound bucket, which boundStorage names too", () => {
    expect(bindingStorage(testEnv).libraryId).toBe(BOUND_LIBRARY_ID);
    expect(BOUND_LIBRARY_ID).toBe(1);
    expect(boundStorage).toBe(bindingStorage);
  });

  it("makes the binding call it is asked for, and no other", async () => {
    const calls: { method: string; argument: unknown }[] = [];
    const music = new Proxy(testEnv.MUSIC, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        return (argument: unknown, ...rest: unknown[]) => {
          calls.push({ method: String(property), argument });
          return value.apply(target, [argument, ...rest]);
        };
      },
    });
    const storage = bindingStorage({ ...testEnv, MUSIC: music });
    const key = "contract/binding/calls/one.flac";

    await storage.put(key, encoder.encode("0123456789"));
    await storage.head(key);
    await storage.get(key);
    await storage.get(key, { offset: 2, length: 3 });
    await storage.list({ prefix: "contract/binding/calls/", limit: 10 });
    await storage.delete([key]);

    expect(calls).toEqual([
      { method: "put", argument: key },
      { method: "head", argument: key },
      { method: "get", argument: key },
      { method: "get", argument: key },
      { method: "list", argument: { prefix: "contract/binding/calls/", limit: 10 } },
      { method: "delete", argument: [key] },
    ]);
  });

  it("passes a failure of the binding through", async () => {
    const failure = new Error("R2 is unavailable");
    const failing = {
      ...testEnv,
      MUSIC: {
        get: async () => {
          throw failure;
        },
        list: async () => {
          throw failure;
        },
      } as unknown as R2Bucket,
    };
    const storage = bindingStorage(failing);

    await expect(storage.get("a", { offset: 0, length: 4 })).rejects.toBe(failure);
    await expect(storage.list({ limit: 1, cursor: "c" })).rejects.toBe(failure);
  });
});
