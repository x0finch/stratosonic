import { library } from "@stratosonic/db";
import { database } from "../src/db";
import { sealCredentials } from "../src/storage/credentials";
import { type FakeS3, libraryTestBucket } from "./fake-s3";
import type { FilesHarness } from "./files-support";
import { allKeys, seedObjects } from "./files-support";
import { encryptionKey, SEED_TIME, testEnv } from "./support";

/**
 * The Files API across libraries (#84, "Files across libraries"; ticket H):
 * a connected library's row pointed at a fake S3 endpoint (test/fake-s3.ts),
 * and one view of either library's bucket, so a route test can run on
 * library 1, the binding, and on library 2, over the S3 API, alike.
 */

export interface FakeLibrary {
  readonly id: number;
  readonly name: string;
  readonly fake: FakeS3;
  /** The bucket the row names: the fake's own unless given, which the fake then does not have. */
  readonly bucket?: string;
  readonly writable?: boolean;
  readonly state?: "active" | "removing";
}

/** Inserts a connected library whose bucket is on `fake`, its token sealed as the API seals one. */
export async function connectFakeLibrary(seed: FakeLibrary): Promise<void> {
  const bucket = seed.bucket ?? seed.fake.bucket;
  const path = `s3://${seed.fake.host}/${bucket}`;
  await database(testEnv)
    .insert(library)
    .values({
      id: seed.id,
      name: seed.name,
      kind: "s3",
      path,
      endpoint: seed.fake.endpoint,
      region: "auto",
      bucket,
      credentials: await sealCredentials(encryptionKey(), path, seed.fake.credentials()),
      writable: seed.writable ?? true,
      defaultNewUsers: false,
      state: seed.state ?? "active",
      createdAt: SEED_TIME,
      updatedAt: SEED_TIME,
    });
}

/** Every key in the fake's bucket, sorted, past its 1,000-a-page listing. */
export async function fakeKeys(prefix?: string): Promise<string[]> {
  const bucket = libraryTestBucket();
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listing = await bucket.list({ prefix, cursor });
    keys.push(...listing.objects.map((object) => object.key));
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor !== undefined);

  return keys.sort();
}

/** Puts each key in the fake's bucket with a few bytes of its own, `concurrency` at a time. */
export async function seedFakeObjects(keys: readonly string[], concurrency = 50): Promise<void> {
  const bucket = libraryTestBucket();
  for (let start = 0; start < keys.length; start += concurrency) {
    await Promise.all(
      keys.slice(start, start + concurrency).map((key) => bucket.put(key, `bytes of ${key}`)),
    );
  }
}

/** Empties the fake's bucket. */
export async function emptyFakeBucket(): Promise<void> {
  const keys = await fakeKeys();
  for (let start = 0; start < keys.length; start += 1000) {
    await libraryTestBucket().delete(keys.slice(start, start + 1000));
  }
}

/**
 * One library's bucket, as a route test sees it: library 1 through the
 * Files harness's recorded binding, a connected library through the fake.
 */
export interface FilesTarget {
  readonly name: string;
  readonly library: number;
  /** The library's reserved prefixes, as `GET /api/files/config` reports them. */
  readonly reserved: readonly string[];
  /** A write's body, naming the library. */
  body(fields: Record<string, unknown>): Record<string, unknown>;
  /** `GET /api/files`'s query, naming the library. */
  query(fields: Record<string, string>): string;
  seed(keys: readonly string[]): Promise<void>;
  put(key: string, bytes: Uint8Array | string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
  /** The bucket's stored object, or null. */
  head(key: string): Promise<R2Object | null>;
  /**
   * The storage calls made since `resetCalls`, each as the binding's method
   * name: an S3 `ListObjectsV2` is `list`, `HeadObject` is `head`, and
   * `DeleteObjects` and `DeleteObject` are `delete`.
   */
  calls(): string[];
  resetCalls(): void;
}

/** Library 1, the binding, through the harness's recorded `MUSIC`. */
export function boundTarget(harness: () => FilesHarness): FilesTarget {
  return {
    name: "library 1 (the binding)",
    library: 1,
    reserved: ["_covers/"],
    body: (fields) => ({ library: 1, ...fields }),
    query: (fields) => new URLSearchParams({ library: "1", ...fields }).toString(),
    seed: (keys) => seedObjects(keys),
    put: async (key, bytes) => {
      await testEnv.MUSIC.put(key, bytes);
    },
    keys: (prefix) => allKeys(prefix),
    head: (key) => testEnv.MUSIC.head(key),
    calls: () => harness().r2Calls.map((call) => call.method),
    resetCalls: () => {
      harness().r2Calls.length = 0;
    },
  };
}

/** A connected library, over the fake S3 endpoint. */
export function fakeTarget(id: number, fake: FakeS3): FilesTarget {
  const names: Record<string, string> = {
    ListObjectsV2: "list",
    HeadObject: "head",
    DeleteObjects: "delete",
    DeleteObject: "delete",
  };
  let from = 0;
  return {
    name: `library ${id} (over the S3 API)`,
    library: id,
    reserved: [],
    body: (fields) => ({ library: id, ...fields }),
    query: (fields) => new URLSearchParams({ library: String(id), ...fields }).toString(),
    seed: (keys) => seedFakeObjects(keys),
    put: async (key, bytes) => {
      await libraryTestBucket().put(key, bytes);
    },
    keys: (prefix) => fakeKeys(prefix),
    head: (key) => libraryTestBucket().head(key),
    calls: () => fake.calls.slice(from).map((call) => names[call.operation] ?? call.operation),
    resetCalls: () => {
      from = fake.calls.length;
    },
  };
}
