import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { readLastScanSummary, readScanProgress } from "../src/scanner/state";
import { bootstrapAdmin, browse } from "./browsing-support";
import { fixtures } from "./fixtures/files";
import { SCAN_TIME, scan, scanUntilComplete, seedFixtureFiles, storedTracks } from "./scan-support";
import { testEnv } from "./support";

/**
 * A pass that does not fit in one run.
 *
 * The limits here are far smaller than the real ones - two objects read per
 * run, three listed at a time - so the five fixtures need several runs, which
 * is exactly the shape a library of thousands has against the real limits.
 * The point of each test is that stopping is safe: the cursor survives, the
 * run picks up where the last one stopped even mid-page, and the library that
 * comes out is the same one a single run would have produced.
 */

/** Small enough that a run stops in the middle of a listing page. */
const CRAWL = { pageSize: 3, extractionsPerRun: 2 };

beforeAll(async () => {
  await bootstrapAdmin();
  await seedFixtureFiles();
});

describe("a scan that stops before the bucket ends", () => {
  it("indexes only its budget and leaves a cursor behind", async () => {
    const run = await scan(SCAN_TIME, CRAWL);

    expect(run.completed).toBe(false);
    expect(run.counts.indexed).toBe(CRAWL.extractionsPerRun);

    const progress = await readScanProgress(database(testEnv));
    expect(progress?.startedAt).toBe(SCAN_TIME.getTime());
    expect(progress?.counts.indexed).toBe(CRAWL.extractionsPerRun);
    // Two of a three-object page were read, so the pass resumes inside it
    // rather than at the next one.
    expect(progress?.cursor).toBe("");
    expect(progress?.skip).toBe(2);
  });

  it("resumes mid-page and does not read what it already read", async () => {
    const run = await scan(SCAN_TIME, CRAWL);

    expect(run.counts.indexed).toBe(CRAWL.extractionsPerRun);
    expect(run.counts.added).toBe(CRAWL.extractionsPerRun);
    expect((await storedTracks()).length).toBe(2 * CRAWL.extractionsPerRun);
  });

  it("completes the pass over as many runs as it takes", async () => {
    const runs = await scanUntilComplete(CRAWL);

    expect(runs.at(-1)?.completed).toBe(true);
    expect((await storedTracks()).map((row) => row.r2Key)).toEqual(
      fixtures.tracks.map((fixture) => fixture.r2Key).sort(),
    );
  });

  it("adds the whole pass up in the summary, not just its last run", async () => {
    const db = database(testEnv);

    expect(await readScanProgress(db)).toBeNull();

    const summary = await readLastScanSummary(db);
    expect(summary?.startedAt).toBe(SCAN_TIME.getTime());
    expect(summary?.counts.indexed).toBe(fixtures.tracks.length);
    expect(summary?.counts.added).toBe(fixtures.tracks.length);
  });

  it("leaves the library a single run would have left", async () => {
    const body = await browse("getArtists");
    const artists = (body.artists?.index ?? []).flatMap((index) => index.artist);

    expect(artists.map((entry) => entry.name).sort()).toEqual(
      [...new Set(fixtures.albums.map((album) => album.albumArtist))].sort(),
    );
    expect(artists.reduce((total, entry) => total + entry.albumCount, 0)).toBe(
      fixtures.albums.length,
    );
  });
});

describe("a rescan that may only look at a few objects", () => {
  it("stops at the objects it was allowed to look at, and resumes", async () => {
    const run = await scan(SCAN_TIME, { objectsPerRun: 2, pageSize: 10 });

    expect(run.completed).toBe(false);
    expect(run.counts.examined).toBe(2);
    expect(run.counts.unchanged).toBe(2);
    expect((await readScanProgress(database(testEnv)))?.skip).toBe(2);

    const rest = await scanUntilComplete({ objectsPerRun: 2, pageSize: 10 });
    expect(rest.at(-1)?.completed).toBe(true);
    expect((await storedTracks()).length).toBe(fixtures.tracks.length);
  });
});
