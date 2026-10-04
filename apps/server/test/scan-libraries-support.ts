import {
  annotation,
  bookmark,
  DEFAULT_LIBRARY_ID,
  type Library,
  library,
  property,
  type Track,
  track,
  trackLyrics,
} from "@stratosonic/db";
import { and, asc, eq, ne } from "drizzle-orm";
import type { MockInstance } from "vitest";
import { database } from "../src/db";
import { readScanProgress, type ScanProgress } from "../src/scanner/state";
import { sealCredentials } from "../src/storage/credentials";
import { s3Path } from "../src/storage/s3";
import { FakeS3, installFakeS3, libraryTestBucket } from "./fake-s3";
import { fixtureBytes } from "./fixtures/files";
import { resetLibrary } from "./scan-support";
import { encryptionKey, SEED_TIME, testEnv } from "./support";

/**
 * Two libraries for the scan driver (#84, "Testing Decisions", "Scan across
 * libraries"): library 1, the bound bucket, and library 2, an R2 bucket
 * served by the fake S3 endpoint (test/fake-s3.ts) from the second miniflare
 * bucket, `LIBRARY_TEST`, with its token sealed in its row as a connected
 * library's is.
 */

/** Library 2's id and name. */
export const ARCHIVE = { id: 2, name: "Archive" } as const;

/** The fake S3 endpoint library 2 is reached through, installed over `fetch`. */
export interface FakeLibrary {
  readonly fake: FakeS3;
  readonly spy: MockInstance<typeof fetch>;
}

/** Installs a fake S3 endpoint over `fetch`; restore it with `spy.mockRestore()`. */
export function installFakeLibrary(): FakeLibrary {
  const fake = new FakeS3();
  return { fake, spy: installFakeS3(fake) };
}

/** Writes library 2's row, `active`, with the fake's sealed token. */
export async function connectLibrary(fake: FakeS3, id: number = ARCHIVE.id): Promise<void> {
  const path = s3Path({ endpoint: fake.endpoint, bucket: fake.bucket });
  await database(testEnv)
    .insert(library)
    .values({
      id,
      name: id === ARCHIVE.id ? ARCHIVE.name : `Library ${id}`,
      path,
      kind: "s3",
      endpoint: fake.endpoint,
      region: "auto",
      bucket: fake.bucket,
      credentials: await sealCredentials(encryptionKey(), path, fake.credentials()),
      createdAt: SEED_TIME,
      updatedAt: SEED_TIME,
    });
}

/** Puts an object in library 2's bucket, behind the fake. */
export async function putInArchive(key: string, bytes: Uint8Array): Promise<void> {
  await libraryTestBucket().put(key, bytes);
}

/** Puts a fixture file in library 2's bucket under `key`. */
export function putFixtureInArchive(key: string, file: string): Promise<void> {
  return putInArchive(key, fixtureBytes(file));
}

/** Puts a fixture file in library 1's bucket under `key`. */
export async function putFixtureInBound(key: string, file: string): Promise<void> {
  await testEnv.MUSIC.put(key, fixtureBytes(file));
}

/**
 * Empties both buckets, the library and the scan's state, removes every
 * library but 1, and clears library 1's scan stamps.
 */
export async function resetLibraries(): Promise<void> {
  const db = database(testEnv);
  await resetLibrary();
  await db.delete(annotation);
  await db.delete(bookmark);
  await db.delete(trackLyrics);
  await db.delete(property);
  await db.delete(library).where(ne(library.id, DEFAULT_LIBRARY_ID));
  await db
    .update(library)
    .set({ lastScanStartedAt: null, lastScanAt: null, lastScanError: null, state: "active" })
    .where(eq(library.id, DEFAULT_LIBRARY_ID));

  const listing = await libraryTestBucket().list();
  if (listing.objects.length > 0) {
    await libraryTestBucket().delete(listing.objects.map((object) => object.key));
  }
}

/** A library's row, as the scan stamps it. */
export async function libraryRow(id: number): Promise<Library | undefined> {
  const [row] = await database(testEnv).select().from(library).where(eq(library.id, id));
  return row;
}

/** A library's tracks, in key order. */
export function tracksIn(libraryId: number): Promise<Track[]> {
  return database(testEnv)
    .select()
    .from(track)
    .where(eq(track.libraryId, libraryId))
    .orderBy(asc(track.r2Key));
}

/** The track of a library with this key, if the library holds one. */
export async function trackAt(libraryId: number, r2Key: string): Promise<Track | undefined> {
  const [row] = await database(testEnv)
    .select()
    .from(track)
    .where(and(eq(track.libraryId, libraryId), eq(track.r2Key, r2Key)));
  return row;
}

/** The scan in flight, as its row says. */
export function progressNow(): Promise<ScanProgress | null> {
  return readScanProgress(database(testEnv));
}

/** The calls the fake recorded from `from` on, by operation. */
export function operationsSince(fake: FakeS3, from: number): string[] {
  return fake.calls.slice(from).map((call) => call.operation);
}
