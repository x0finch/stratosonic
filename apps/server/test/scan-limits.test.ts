import { prefixedId, trackId } from "@stratosonic/db";
import { afterEach, describe, expect, it } from "vitest";
import { D1_MAX_BOUND_PARAMETERS } from "../src/d1-limits";
import { database } from "../src/db";
import { readBrokenObjects } from "../src/scanner/state";
import { bootstrapAdmin, browse } from "./browsing-support";
import { fixtureBytes } from "./fixtures/files";
import {
  resetLibrary,
  SCAN_TIME,
  scan,
  scanCountingParameters,
  storedTracks,
} from "./scan-support";
import { testEnv } from "./support";

/**
 * The budget every scan run lives inside, tested where Miniflare cannot catch
 * a breach: D1's ceiling of a hundred bound parameters per statement, and the
 * memo that keeps a permanently broken file from spending a read every pass.
 */

/** Enough audio objects that a whole listing page of keys would overflow a
 * single `in (...)` — more than D1's hundred-parameter limit. */
const MANY = 130;

/**
 * Puts a distinct, tagless audio object at `key`. The bytes are the untagged
 * fixture, so each lands under the artist and album its own path implies
 * rather than collapsing into one album by a shared tag — the page then
 * writes many artist, album and track rows, and every one of its statements
 * is on trial.
 */
async function silence(key: string): Promise<void> {
  await testEnv.MUSIC.put(key, fixtureBytes("untagged.mp3"));
}

afterEach(resetLibrary);

describe("a page larger than D1's parameter limit", () => {
  it("never binds more than a hundred parameters in one statement", async () => {
    await bootstrapAdmin();
    for (let index = 0; index < MANY; index++) {
      // Distinct albums so the page also writes many artist and album rows,
      // not just tracks: every statement the page runs is on trial here.
      await silence(`Artist ${index}/Album ${index}/01 Track.mp3`);
    }

    // A page far bigger than the limit, so a naive `in (...)` over the page
    // would bind well past a hundred and throw in production.
    const { run, boundCounts } = await scanCountingParameters({ pageSize: MANY });

    expect(run.completed).toBe(true);
    expect(run.counts.indexed).toBe(MANY);
    expect(Math.max(...boundCounts)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
  });

  it("sweeps a page larger than the limit without overflowing a statement", async () => {
    await bootstrapAdmin();
    for (let index = 0; index < MANY; index++) {
      await silence(`Artist ${index}/Album ${index}/01 Track.mp3`);
    }
    await scan(SCAN_TIME, { pageSize: MANY });

    // Every object goes at once: the next completed page has a deletion whose
    // interval spans them all, which the sweep must chunk.
    const listing = await testEnv.MUSIC.list();
    await testEnv.MUSIC.delete(listing.objects.map((object) => object.key));

    const later = new Date(SCAN_TIME.getTime() + 60_000);
    const { run, boundCounts } = await scanCountingParameters(
      { pageSize: MANY, deletionsPerPage: MANY },
      later,
    );

    expect(run.completed).toBe(true);
    expect(run.counts.removed).toBe(MANY);
    expect(Math.max(...boundCounts)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    expect((await storedTracks()).length).toBe(0);
  });
});

describe("a file that cannot be read", () => {
  const BROKEN_KEY = "Broken Artist/Broken Album/01 Not Audio.mp3";

  it("is remembered so a later pass does not read it again", async () => {
    await bootstrapAdmin();
    await testEnv.MUSIC.put(BROKEN_KEY, new Uint8Array(5000).fill(0x41));

    const first = await scan();
    expect(first.completed).toBe(true);
    expect(first.counts.broken).toBe(1);

    // The memo now holds the key at the etag it was broken at.
    const remembered = await readBrokenObjects(database(testEnv));
    expect(remembered.has(BROKEN_KEY)).toBe(true);

    // A second pass counts it broken again but never spends a read on it:
    // with an extraction budget of zero it would otherwise be deferred.
    const second = await scan(new Date(SCAN_TIME.getTime() + 60_000), { extractionsPerRun: 0 });
    expect(second.completed).toBe(true);
    expect(second.counts.broken).toBe(1);
    expect(second.counts.deferred).toBe(0);
  });

  it("is read again once its bytes change", async () => {
    await bootstrapAdmin();
    await testEnv.MUSIC.put(BROKEN_KEY, new Uint8Array(5000).fill(0x41));
    await scan();

    // Re-uploaded as real audio: a new etag, no longer a match for the memo.
    await testEnv.MUSIC.put(BROKEN_KEY, fixtureBytes("silent-track.mp3"));

    const run = await scan(new Date(SCAN_TIME.getTime() + 120_000));
    expect(run.counts.broken).toBe(0);
    expect(run.counts.added).toBe(1);

    // The re-uploaded bytes are the tagged silent-track fixture, so the row
    // now carries that fixture's title rather than anything from the path.
    const body = await browse("getSong", { id: prefixedId("track", trackId(BROKEN_KEY)) });
    expect(body.song?.title).toBe("Silent Track");

    expect((await readBrokenObjects(database(testEnv))).has(BROKEN_KEY)).toBe(false);
  });

  it("is forgotten once its object leaves the bucket", async () => {
    await bootstrapAdmin();
    await testEnv.MUSIC.put(BROKEN_KEY, new Uint8Array(5000).fill(0x41));
    await scan();
    expect((await readBrokenObjects(database(testEnv))).has(BROKEN_KEY)).toBe(true);

    await testEnv.MUSIC.delete(BROKEN_KEY);
    await scan(new Date(SCAN_TIME.getTime() + 60_000));

    expect((await readBrokenObjects(database(testEnv))).has(BROKEN_KEY)).toBe(false);
  });
});
