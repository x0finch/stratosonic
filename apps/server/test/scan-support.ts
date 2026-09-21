import { type Album, type Artist, album, artist, type Track, track } from "@stratosonic/db";
import { asc } from "drizzle-orm";
import { database } from "../src/db";
import { DEFAULT_SCAN_LIMITS, runScan, type ScanLimits, type ScanRun } from "../src/scanner/scan";
import { fixtures } from "./fixtures/files";
import { seedFixtureObject, testEnv } from "./support";

/**
 * Driving the Scan from a test.
 *
 * The scan is reached through `runScan`, which the `scheduled` entry calls
 * with the cron's time; there is no HTTP way in, because Phase 1 does not
 * implement the scan-control endpoints - #9 leaves those in the backlog.
 * What a scan *produced* is asserted through the `fetch` handler like
 * everything else; these helpers only start it and read back the few columns
 * no endpoint renders, such as the etag a rescan compares against.
 */

/** The instant a scan is stamped with, unless a test wants another. */
export const SCAN_TIME = new Date(1_750_000_000_000);

/** One run of the scan, with whichever limits the test needs. */
export function scan(now: Date = SCAN_TIME, limits: Partial<ScanLimits> = {}): Promise<ScanRun> {
  return runScan(testEnv, now, { ...DEFAULT_SCAN_LIMITS, ...limits });
}

/**
 * Runs the scan until a pass completes, and hands back every run it took.
 * A cron spreads these over as many invocations as a library needs; a test
 * does not want to wait a quarter of an hour between them.
 */
export async function scanUntilComplete(
  limits: Partial<ScanLimits> = {},
  now: Date = SCAN_TIME,
): Promise<ScanRun[]> {
  const runs: ScanRun[] = [];

  // A pass that has not finished after this many runs is a loop, not a scan.
  for (let attempt = 0; attempt < 50; attempt++) {
    const run = await scan(now, limits);
    runs.push(run);
    if (run.completed) {
      return runs;
    }
  }

  throw new Error("the scan never completed");
}

/**
 * Puts the fixture audio and the `.m3u` in the bucket, and nothing else: the
 * cover objects `seedFixtureObjects` writes for the read endpoints are what a
 * scan is supposed to produce, so a scan test must start without them.
 */
export async function seedFixtureFiles(): Promise<void> {
  for (const fixture of fixtures.tracks) {
    await seedFixtureObject(fixture.file);
  }

  await seedFixtureObject(fixtures.playlist.file);
}

/** Every track row, in key order, for the columns no endpoint renders. */
export function storedTracks(): Promise<Track[]> {
  return database(testEnv).select().from(track).orderBy(asc(track.r2Key));
}

export function storedAlbums(): Promise<Album[]> {
  return database(testEnv).select().from(album).orderBy(asc(album.name));
}

export function storedArtists(): Promise<Artist[]> {
  return database(testEnv).select().from(artist).orderBy(asc(artist.name));
}

/** The keys in the bucket, which is how a test sees what the scan wrote. */
export async function bucketKeys(prefix?: string): Promise<string[]> {
  const listing = await testEnv.MUSIC.list(prefix === undefined ? {} : { prefix });

  return listing.objects.map((object) => object.key).sort();
}

/** When each cover object was last written; a rewrite moves the time on. */
export async function coverUploads(): Promise<Map<string, number>> {
  const listing = await testEnv.MUSIC.list({ prefix: "_covers/" });

  return new Map(listing.objects.map((object) => [object.key, object.uploaded.getTime()]));
}

/** The bucket as the scan sees it: each key's etag, size and upload time. */
export async function listedObjects(): Promise<
  Map<string, { etag: string; size: number; uploaded: Date }>
> {
  const listing = await testEnv.MUSIC.list();

  return new Map(
    listing.objects.map((object) => [
      object.key,
      { etag: object.etag, size: object.size, uploaded: object.uploaded },
    ]),
  );
}
