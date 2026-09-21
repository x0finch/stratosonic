import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import worker from "../src/index";
import { readLastScanSummary, readScanProgress, type ScanSummary } from "../src/scanner/state";
import { bootstrapAdmin } from "./browsing-support";
import { fixtures } from "./fixtures/files";
import { seedFixtureFiles } from "./scan-support";
import { testEnv } from "./support";

/**
 * Phase 1, end to end (#18): the bucket is seeded, the cron entry runs, and
 * everything after that is what a client would see.
 *
 * This file is the proof that the parts fit together, so it goes through the
 * two seams and nothing else — the `scheduled` handler exported by
 * `src/index.ts`, exactly as the cron invokes it, and the `fetch` handler
 * every assertion reads the library through. No row is read or written
 * directly; the only thing taken from D1 is the scan's own summary of a pass,
 * which is a report of the run rather than a statement about the library.
 *
 * The bucket starts with the five audio fixtures and the one `.m3u`, and
 * nothing else: the covers under `_covers/` are what a scan produces. Every
 * expectation comes from `manifest.json`, which the fixture generator writes.
 *
 * The three parts below are the history of one library, in order: it is
 * indexed, it is scanned again and does not move, and then two objects leave
 * the bucket and the library follows.
 */

/** The cron that carries the scan in production, from wrangler.jsonc. */
const CRON = "*/15 * * * *";

/** The instant the first cron run is stamped with. */
const FIRST_RUN = new Date(1_750_000_000_000);

/** How many cron invocations the first pass over the fixtures took. */
let firstPassInvocations = 0;
/* --------------------------------------------------------- the seams -- */

/**
 * One cron invocation: the real `scheduled` export, with the controller the
 * runtime hands it. A test drives the schedule itself rather than waiting a
 * quarter of an hour between runs.
 */
async function runScheduled(now: Date): Promise<void> {
  const controller: ScheduledController = {
    scheduledTime: now.getTime(),
    cron: CRON,
    noRetry() {
      // A cron run that fails is not retried; the next one resumes the pass.
    },
  };

  await worker.scheduled(controller, testEnv);
}

/**
 * Invokes the cron until the pass it started has finished, and says how many
 * invocations that took. A pass is finished when the scan has left no
 * progress behind and has recorded a summary of this pass — the same two
 * properties the next cron run reads.
 */
async function scheduledUntilComplete(now: Date): Promise<number> {
  const db = database(testEnv);

  // A pass that has not finished after this many runs is a loop, not a scan.
  for (let invocations = 1; invocations <= 20; invocations++) {
    await runScheduled(now);

    const summary = await readLastScanSummary(db);
    if ((await readScanProgress(db)) === null && summary?.startedAt === now.getTime()) {
      return invocations;
    }
  }

  throw new Error("the scheduled entry never completed a pass");
}

/** What the pass that began at this instant did, as the scan recorded it. */
async function summaryOf(now: Date): Promise<ScanSummary> {
  const summary = await readLastScanSummary(database(testEnv));
  if (summary?.startedAt !== now.getTime()) {
    throw new Error("no completed pass started at that instant");
  }

  return summary;
}
beforeAll(async () => {
  await bootstrapAdmin();
  await seedFixtureFiles();
  firstPassInvocations = await scheduledUntilComplete(FIRST_RUN);
});
/* ============================================================ the scan == */

describe("the cron indexing a fresh bucket", () => {
  it("finishes the pass in a single invocation at the production limits", () => {
    expect(firstPassInvocations).toBe(1);
  });

  it("reports a pass that read every fixture and broke on none", async () => {
    const summary = await summaryOf(FIRST_RUN);

    expect(summary.counts.indexed).toBe(fixtures.tracks.length);
    expect(summary.counts.added).toBe(fixtures.tracks.length);
    expect(summary.counts.broken).toBe(0);
    expect(summary.counts.deferred).toBe(0);
    expect(summary.counts.removed).toBe(0);
  });
});
