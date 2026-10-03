/**
 * CPU of parsing a `ListObjectsV2` page in workerd, the runtime the Worker
 * runs on (#84, "Files across libraries": the gate is <= 4 ms per 1,000
 * entries).
 *
 *   pnpm --filter @stratosonic/server bench:s3-list
 *
 * Not part of the test suite or CI: its numbers depend on the machine. It
 * runs locally only, deploys nothing and needs no Cloudflare account.
 *
 * workerd does not advance `Date.now()` or `performance.now()` while
 * JavaScript runs (bench-files.ts), so the time is taken from outside: a
 * request to bench-s3-list-worker.ts, under `wrangler dev` (`unstable_dev`),
 * that parses a page `RUNS` times, less one that parses it no time, divided
 * by `RUNS`. What is left is the parse alone, in workerd's V8, with the
 * request's own overhead taken out. The page is bench-s3-xml.ts's worst
 * case: every key URL-encoded non-ASCII.
 */

import { unstable_dev } from "wrangler";

const RUNS = 100;
const SAMPLES = 25;

const worker = await unstable_dev("scripts/bench-s3-list-worker.ts", {
  config: "scripts/bench-s3-list.jsonc",
  local: true,
  logLevel: "warn",
  experimental: { disableExperimentalWarning: true },
});

async function timed(entries: number, runs: number): Promise<number> {
  const start = performance.now();
  const response = await worker.fetch(`/?entries=${entries}&runs=${runs}`);
  const objects = Number(await response.text());
  const elapsed = performance.now() - start;
  if (response.status !== 200 || (runs > 0 && objects === 0)) {
    throw new Error(`the bench Worker answered ${response.status}`);
  }
  return elapsed;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const results: Record<string, string>[] = [];
try {
  for (const entries of [500, 1000]) {
    // Warm up: the page built, the parser compiled and optimised.
    for (let warm = 0; warm < 5; warm++) {
      await timed(entries, RUNS);
    }
    const perParse: number[] = [];
    for (let sample = 0; sample < SAMPLES; sample++) {
      const empty = await timed(entries, 0);
      const full = await timed(entries, RUNS);
      perParse.push((full - empty) / RUNS);
    }
    const sorted = [...perParse].sort((a, b) => a - b);
    results.push({
      name: `ListObjectsV2 XML parsed in workerd, ${entries.toLocaleString("en")} entries`,
      "p50 ms": median(perParse).toFixed(3),
      "p90 ms": (sorted[Math.floor(sorted.length * 0.9)] ?? 0).toFixed(3),
    });
  }
} finally {
  await worker.stop();
}

console.log("workerd under wrangler dev (local)");
console.table(results);
