import { prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { DEFAULT_SCAN_LIMITS, runScan } from "../src/scanner/scan";
import { bootstrapAdmin, browse } from "./browsing-support";
import { fixtures, fixtureTrack } from "./fixtures/files";
import { SCAN_TIME, scan, seedFixtureFiles, storedTracks } from "./scan-support";
import { testEnv } from "./support";

/**
 * A bucket that answers with an error is not a broken file.
 *
 * The two arrive at the scan the same way - a parse that threw - and telling
 * them apart is why `MetadataError` carries `source-failed` at all (#21). A
 * track written off because R2 was briefly unavailable would stay missing
 * from the library until someone re-uploaded the file, so the object is
 * deliberately left unindexed instead: the next run finds it unknown, reads
 * it again, and indexes it.
 *
 * The failure is injected at the binding rather than simulated further down,
 * so what is exercised is the scan's real path through `r2Source`.
 */

const UNAVAILABLE = fixtureTrack("hushed-interlude.flac");

/** The test bucket, except that reading one object fails. */
function bucketFailingToRead(key: string): R2Bucket {
  return new Proxy(testEnv.MUSIC, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }

      const method = value.bind(target);
      if (property !== "get") {
        return method;
      }

      return (...args: unknown[]) => {
        if (args[0] === key) {
          throw new Error(`R2 is unavailable for ${key}`);
        }

        return method(...args);
      };
    },
  });
}

beforeAll(async () => {
  await bootstrapAdmin();
  await seedFixtureFiles();
});

describe("a scan that meets a bucket error", () => {
  it("defers the object rather than writing it off, and finishes the pass", async () => {
    const env: Env = { ...testEnv, MUSIC: bucketFailingToRead(UNAVAILABLE.r2Key) };

    const run = await runScan(env, SCAN_TIME, DEFAULT_SCAN_LIMITS);

    expect(run.completed).toBe(true);
    expect(run.counts.deferred).toBe(1);
    expect(run.counts.broken).toBe(0);
    expect(run.counts.indexed).toBe(fixtures.tracks.length - 1);
  });

  it("leaves the track out of the library for now", async () => {
    const body = await browse("getSong", {
      id: prefixedId("track", trackId(UNAVAILABLE.r2Key)),
    });

    expect(body.error?.code).toBe(70);
  });

  it("indexes it on the next run, when the bucket answers again", async () => {
    const run = await scan(new Date(SCAN_TIME.getTime() + 900_000));

    expect(run.counts.deferred).toBe(0);
    expect(run.counts.added).toBe(1);
    expect((await storedTracks()).map((row) => row.r2Key)).toEqual(
      fixtures.tracks.map((fixture) => fixture.r2Key).sort(),
    );
  });
});
