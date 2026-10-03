/**
 * CPU of the Files routes' own work (#83, "Free-tier budget"):
 * `GET /api/files` on a folder of 1,000 entries, one 2,000-key round of
 * `POST /api/files/delete-folder`, and the worst case of
 * `POST /api/files/uploads/check` (500 keys, 2,000 entries listed).
 *
 *   pnpm --filter @stratosonic/server bench:files
 *
 * Not part of the test suite or CI: its numbers depend on the machine.
 *
 * Why Node, and why only this part: workerd does not advance `Date.now()` or
 * `performance.now()` while JavaScript runs, so CPU cannot be timed inside a
 * Worker or the Workers-pool tests (bench-console-auth.ts says the same).
 * What the routes compute themselves is what runs here, through the same
 * modules: turning R2's listing into the answer (`folderListing`, then the
 * JSON `c.json` writes), and, for a folder delete, collecting the keys of two
 * pages of 1,000, picking the playlists among them (`playlistKeysOf`), and the
 * answer. The R2, D1 and Durable Object calls are I/O, which the Worker waits
 * for and is not billed CPU for; the session check before the handler is
 * measured by bench-console-auth.ts. Confirm on the edge with Workers
 * Observability (`cpuTime`).
 */

import { CHECK_BATCH, type ExistingKey, groupCheckKeys, matchListing } from "../src/files/check";
import { type DelimitedListing, folderListing, playlistKeysOf } from "../src/files/listing";

const RUNS = 2_000;
const WARM_UP = 200;

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

function bench(name: string, work: () => unknown): Record<string, string> {
  for (let run = 0; run < WARM_UP; run++) {
    work();
  }
  const times: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const start = performance.now();
    work();
    times.push(performance.now() - start);
  }

  return {
    name,
    "p50 ms": percentile(times, 50).toFixed(3),
    "p95 ms": percentile(times, 95).toFixed(3),
  };
}

const uploaded = new Date("2026-10-02T06:00:00.000Z");
const PREFIX = "Some Artist With A Long Name/Some Album (2024) [FLAC 24-96]/";

/** A folder of 1,000 entries: 20 subfolders and 980 files of every kind. */
const browsePage: DelimitedListing = {
  delimitedPrefixes: Array.from({ length: 20 }, (_, index) => `${PREFIX}CD${index + 1}/`),
  objects: Array.from({ length: 980 }, (_, index) => ({
    key: `${PREFIX}${String(index).padStart(3, "0")} A Track Title Of Middling Length.${
      ["flac", "lrc", "jpg", "m3u", "cue"][index % 5]
    }`,
    size: 41_234_567 + index,
    uploaded,
  })),
  truncated: true,
  cursor: "opaque-cursor-of-some-length-0123456789abcdef",
};

/** Two listing pages of 1,000 keys under one folder, as a delete-folder round sees them. */
const deletePages = [0, 1].map((page) => ({
  objects: Array.from({ length: 1000 }, (_, index) => ({
    key: `${PREFIX}${page}/${String(index).padStart(4, "0")} A Track Title.${
      index % 50 === 0 ? "m3u" : "flac"
    }`,
  })),
}));

/**
 * An upload check's worst case: `n` keys, every one past the folder
 * prefix in non-ASCII (so each is checked and normalised in full), parsed
 * from the request body, checked against the upload rules and grouped
 * (`groupCheckKeys`), matched against two listing pages of 1,000 names
 * that are non-ASCII too (`matchListing`, the `CHECK_ENTRIES` bound), and
 * answered. The listings and `head()` calls are I/O.
 */
function checkBody(n: number): string {
  return JSON.stringify({
    prefix: PREFIX,
    keys: Array.from(
      { length: n },
      (_, index) =>
        `${PREFIX}${String(index).padStart(4, "0")} Ünïcödé Träck Tïtlé Of Middling Length.flac`,
    ),
  });
}

const checkPages = [0, 1].map((page) =>
  Array.from({ length: 1000 }, (_, index) => ({
    key: `${PREFIX}${String(page * 1000 + index).padStart(4, "0")} Ünïcödé Träck Tïtlé Of Middling Length.flac`.normalize(
      "NFD",
    ),
    size: 41_234_567 + index,
    uploaded,
  })),
);

function check(body: string) {
  const { prefix, keys } = JSON.parse(body) as { prefix: string; keys: string[] };
  const folders = groupCheckKeys(prefix, keys);
  const existing: ExistingKey[] = [];
  for (const [folder, names] of folders) {
    for (const page of checkPages) {
      matchListing(folder, names, page, existing);
    }
  }
  return JSON.stringify({ existing, unchecked: [] });
}

const check500 = checkBody(CHECK_BATCH);
const check1000 = checkBody(1000);

const results = [
  bench("GET /api/files, 1,000 entries", () => JSON.stringify(folderListing(PREFIX, browsePage))),
  bench("POST /api/files/delete-folder, 2,000 keys", () => {
    const deleted: string[] = [];
    for (const page of deletePages) {
      const keys = page.objects.map((object) => object.key);
      deleted.push(...keys);
    }
    playlistKeysOf(deleted);
    return JSON.stringify({ deleted: deleted.length, done: false, scan: null });
  }),
  bench(`POST /api/files/uploads/check, ${CHECK_BATCH} keys, 2,000 entries`, () => check(check500)),
  // Its parts: the keys checked and grouped, and the 2,000 names matched.
  bench(`  of which: ${CHECK_BATCH} keys parsed, checked and grouped`, () => {
    const { prefix, keys } = JSON.parse(check500) as { prefix: string; keys: string[] };
    return groupCheckKeys(prefix, keys);
  }),
  bench("  of which: 2,000 listed names matched", () => {
    const names = new Map([["nothing.flac", ["x"]]]);
    for (const page of checkPages) {
      matchListing(PREFIX, names, page, []);
    }
  }),
  // The former bound, for comparison.
  bench("POST /api/files/uploads/check, 1,000 keys, 2,000 entries", () => check(check1000)),
];

console.log(`node ${process.version}, ${process.arch}`);
console.table(results);
