import { afterEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { runScan } from "../src/scanner/scan";
import { readScanProgress } from "../src/scanner/state";
import { bootstrapAdmin } from "./browsing-support";
import { fixtureBytes } from "./fixtures/files";
import {
  resetLibrary,
  SCAN_TIME,
  scan,
  scanUntilComplete,
  storedTracks,
  UNBOUNDED_LIMITS,
} from "./scan-support";
import { testEnv } from "./support";

/**
 * The deletion sweep across more than one page, and a run that dies in the
 * middle of a page.
 *
 * The sweep is the part of a scan with the least room to be almost-right: it
 * runs a page at a time over an interval of the key space, and a bug in the
 * bounds deletes either too much (a track a later page still lists) or too
 * little (a track that is gone). A single-page fixture cannot show that, so
 * everything here runs at `pageSize: 2`, where the objects that remain and
 * the objects that are gone fall in different pages.
 */

/** Six objects in known key order, so which page each falls in is fixed. */
const KEYS = [
  "A Artist/Album/01.mp3",
  "B Artist/Album/01.mp3",
  "C Artist/Album/01.mp3",
  "D Artist/Album/01.mp3",
  "E Artist/Album/01.mp3",
  "F Artist/Album/01.mp3",
] as const;

async function seedSix(): Promise<void> {
  for (const key of KEYS) {
    await testEnv.MUSIC.put(key, fixtureBytes("untagged.mp3"));
  }
}

afterEach(resetLibrary);

describe("the sweep across several pages", () => {
  it("removes a track gone from an earlier page and keeps the rest", async () => {
    await bootstrapAdmin();
    await seedSix();
    await scanUntilComplete({ pageSize: 2 });
    expect((await storedTracks()).length).toBe(KEYS.length);

    // One object from the first page and one from the last are deleted, so
    // the sweep has to act in a page it is no longer looking at objects in.
    await testEnv.MUSIC.delete([KEYS[0], KEYS[5]]);

    const runs = await scanUntilComplete({ pageSize: 2 }, new Date(SCAN_TIME.getTime() + 60_000));

    expect(runs.at(-1)?.completed).toBe(true);
    expect(runs.reduce((total, run) => total + run.counts.removed, 0)).toBe(2);
    expect((await storedTracks()).map((row) => row.r2Key)).toEqual([
      KEYS[1],
      KEYS[2],
      KEYS[3],
      KEYS[4],
    ]);
  });

  it("advances sweptTo page by page while a pass is in flight", async () => {
    await bootstrapAdmin();
    await seedSix();

    // One page per run, so the pass takes several and the cursor is visible
    // between them.
    const walk = { pageSize: 2, pagesPerRun: 1, extractionsPerRun: 100 };

    await scan(SCAN_TIME, walk);
    const first = await readScanProgress(database(testEnv));
    expect(first?.sweptTo).toBe(KEYS[1]);

    await scan(SCAN_TIME, walk);
    const second = await readScanProgress(database(testEnv));
    expect(second?.sweptTo).toBe(KEYS[3]);

    const rest = await scanUntilComplete(walk);
    expect(rest.at(-1)?.completed).toBe(true);
    // The final, unbounded page clears the cursor rather than leaving sweptTo
    // at the last key.
    expect(await readScanProgress(database(testEnv))).toBeNull();
  });
});

describe("a run that dies between pages", () => {
  /**
   * The test bucket, but the Nth `list` throws.
   *
   * A `list` failure escapes `runScan` — it is not the metadata read that the
   * scan catches and defers — so it models a run cut short after an earlier
   * page had committed, the way the uncatchable 10 ms CPU kill would. The
   * page before it committed its rows and its cursor together, so its work
   * survives and the resume starts from that cursor.
   */
  function bucketFailingOnNthList(failAt: number): R2Bucket {
    let lists = 0;

    return new Proxy(testEnv.MUSIC, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") {
          return value;
        }

        const method = value.bind(target);
        if (property !== "list") {
          return method;
        }

        return (...args: unknown[]) => {
          lists += 1;
          if (lists === failAt) {
            throw new Error("R2 fell over between pages");
          }

          return method(...args);
        };
      },
    });
  }

  it("keeps the page it committed and resumes, sweeping correctly after", async () => {
    await bootstrapAdmin();
    await seedSix();

    // The first page (keys 0 and 1) lists, indexes and commits; the second
    // page's `list` throws before it does anything.
    const failing: Env = { ...testEnv, MUSIC: bucketFailingOnNthList(2) };
    const crawl = { pageSize: 2, pagesPerRun: 10, extractionsPerRun: 100 };

    await expect(runScan(failing, SCAN_TIME, { ...UNBOUNDED_LIMITS, ...crawl })).rejects.toThrow();

    // Exactly the first page survived — its batch committed the rows with the
    // cursor that stands for them.
    expect((await storedTracks()).map((row) => row.r2Key)).toEqual([KEYS[0], KEYS[1]]);
    expect(await readScanProgress(database(testEnv))).not.toBeNull();

    // Meanwhile an object in a page not yet reached goes. A healthy resume
    // must both finish indexing and sweep the missing one.
    await testEnv.MUSIC.delete(KEYS[4]);

    const rest = await scanUntilComplete(crawl, new Date(SCAN_TIME.getTime() + 60_000));
    expect(rest.at(-1)?.completed).toBe(true);
    expect((await storedTracks()).map((row) => row.r2Key)).toEqual([
      KEYS[0],
      KEYS[1],
      KEYS[2],
      KEYS[3],
      KEYS[5],
    ]);
  });
});
