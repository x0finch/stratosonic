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
 * modules: turning R2's listing into the storage's (`fromR2Listing`,
 * storage/binding.ts) and that into the answer (`folderListing`, then the
 * JSON `c.json` writes), and, for a folder delete, the same for two pages of
 * 1,000, collecting their keys, picking the playlists among them
 * (`playlistKeysOf`), and the answer. The R2, D1 and Durable Object calls are I/O, which the Worker waits
 * for and is not billed CPU for; the session check before the handler is
 * measured by bench-console-auth.ts. Confirm on the edge with Workers
 * Observability (`cpuTime`).
 *
 * For a library over the S3 API (#84, "Files across libraries"), the route
 * also parses R2's `ListObjectsV2` XML (storage/s3-list.ts), which the
 * binding never does: the `S3:` rows time it at 500 and 1,000 entries (the
 * gate is <= 4 ms per 1,000, measured in workerd by
 * bench-s3-list-workerd.ts), the 1,000-entry browse built on it, and a
 * connected library's presigned upload with its sealed token opened.
 */

import { CHECK_BATCH, type ExistingKey, groupCheckKeys, matchListing } from "../src/files/check";
import { folderListing, playlistKeysOf } from "../src/files/listing";
import { fromR2Listing } from "../src/storage/binding";
import { openCredentials, sealCredentials } from "../src/storage/credentials";
import { s3Storage } from "../src/storage/s3";
import { parseListObjectsV2 } from "../src/storage/s3-list";
import { LISTING_PREFIX, listingXml } from "./bench-s3-xml";

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

/** An etag as R2 answers it: 32 hex digits, unquoted. */
const ETAG = "0123456789abcdef0123456789abcdef";

/**
 * A page as the binding answers it (`R2Objects`), with the fields a listing
 * carries: the storage turns it into its own (`fromR2Listing`).
 */
function r2Page(
  objects: readonly { readonly key: string; readonly size: number }[],
  delimitedPrefixes: string[] = [],
) {
  return {
    objects: objects.map(({ key, size }) => ({ key, size, etag: ETAG, uploaded })),
    delimitedPrefixes,
    truncated: true,
    cursor: "opaque-cursor-of-some-length-0123456789abcdef",
  } as unknown as R2Objects;
}

/** A folder of 1,000 entries: 20 subfolders and 980 files of every kind. */
const browsePage = r2Page(
  Array.from({ length: 980 }, (_, index) => ({
    key: `${PREFIX}${String(index).padStart(3, "0")} A Track Title Of Middling Length.${
      ["flac", "lrc", "jpg", "m3u", "cue"][index % 5]
    }`,
    size: 41_234_567 + index,
  })),
  Array.from({ length: 20 }, (_, index) => `${PREFIX}CD${index + 1}/`),
);

/** Two listing pages of 1,000 keys under one folder, as a delete-folder round sees them. */
const deletePages = [0, 1].map((page) =>
  r2Page(
    Array.from({ length: 1000 }, (_, index) => ({
      key: `${PREFIX}${page}/${String(index).padStart(4, "0")} A Track Title.${
        index % 50 === 0 ? "m3u" : "flac"
      }`,
      size: 41_234_567 + index,
    })),
  ),
);

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
  r2Page(
    Array.from({ length: 1000 }, (_, index) => ({
      key: `${PREFIX}${String(page * 1000 + index).padStart(4, "0")} Ünïcödé Träck Tïtlé Of Middling Length.flac`.normalize(
        "NFD",
      ),
      size: 41_234_567 + index,
    })),
  ),
);

function check(body: string) {
  const { prefix, keys } = JSON.parse(body) as { prefix: string; keys: string[] };
  const folders = groupCheckKeys(prefix, keys);
  const existing: ExistingKey[] = [];
  for (const [folder, names] of folders) {
    for (const page of checkPages) {
      matchListing(folder, names, fromR2Listing(page).objects, existing);
    }
  }
  return JSON.stringify({ existing, unchecked: [] });
}

const check500 = checkBody(CHECK_BATCH);
const check1000 = checkBody(1000);

const results = [
  bench("GET /api/files, 1,000 entries", () =>
    JSON.stringify(folderListing(PREFIX, fromR2Listing(browsePage))),
  ),
  bench("POST /api/files/delete-folder, 2,000 keys", () => {
    const deleted: string[] = [];
    for (const page of deletePages) {
      const keys = fromR2Listing(page).objects.map((object) => object.key);
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
      matchListing(PREFIX, names, fromR2Listing(page).objects, []);
    }
  }),
  // The former bound, for comparison.
  bench("POST /api/files/uploads/check, 1,000 keys, 2,000 entries", () => check(check1000)),
];

/* ------------------------------------------------------- S3 libraries -- */

// #84, "Files across libraries": the gate is <= 4 ms per 1,000 entries
// parsed, in workerd (bench-s3-list-workerd.ts measures it there).
const xml500 = listingXml(500);
const xml1000 = listingXml(1000);

results.push(
  bench("S3: ListObjectsV2 XML parsed, 500 entries", () => parseListObjectsV2(xml500)),
  bench("S3: ListObjectsV2 XML parsed, 1,000 entries", () => parseListObjectsV2(xml1000)),
  bench("S3: GET /api/files?library=2, 1,000 entries (parse, listing, JSON)", () =>
    JSON.stringify(folderListing(LISTING_PREFIX, parseListObjectsV2(xml1000))),
  ),
);

/** Times an async operation, as `bench` times a synchronous one. */
async function benchAsync(
  name: string,
  work: () => Promise<unknown>,
  runs = RUNS,
): Promise<Record<string, string>> {
  for (let run = 0; run < WARM_UP; run++) {
    await work();
  }
  const times: number[] = [];
  for (let run = 0; run < runs; run++) {
    const start = performance.now();
    await work();
    times.push(performance.now() - start);
  }
  return {
    name,
    "p50 ms": percentile(times, 50).toFixed(3),
    "p95 ms": percentile(times, 95).toFixed(3),
  };
}

// A connected library's upload URL as a Files route signs it: the row's
// sealed token opened (one AES-GCM decrypt, the key derived once per
// isolate), then the URL signed with the library's client (cached per
// isolate, its signing key per day). Every credential here is made up.
const PASSPHRASE = "bench-password-encryption-key";
const ACCOUNT = "fedcba9876543210fedcba9876543210";
const PATH = `s3://${ACCOUNT}.r2.cloudflarestorage.com/archive`;
const sealed = await sealCredentials(PASSPHRASE, PATH, {
  accessKeyId: "bench-access-key-id",
  secretAccessKey: "bench-secret-access-key-not-real",
});
const location = {
  libraryId: 2,
  endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  bucket: "archive",
};
const upload = {
  key: "Artist/Album/01 Title.flac",
  size: 41_234_567,
  contentType: "audio/flac",
  replace: false,
};

results.push(
  await benchAsync("S3: open sealed credentials (AES-GCM decrypt)", () =>
    openCredentials(PASSPHRASE, PATH, sealed),
  ),
  await benchAsync("S3: presignPut with decrypt (a fresh storage, warm client)", () =>
    s3Storage(location, () => openCredentials(PASSPHRASE, PATH, sealed)).presignPut(upload),
  ),
  await benchAsync(
    "S3: 10 presignPut, one decrypt (POST /api/files/uploads, 10 files)",
    async () => {
      const storage = s3Storage(location, () => openCredentials(PASSPHRASE, PATH, sealed));
      for (let index = 0; index < 10; index++) {
        await storage.presignPut({ ...upload, key: `Artist/Album/${index} Title.flac` });
      }
    },
    500,
  ),
);

console.log(`node ${process.version}, ${process.arch}`);
console.table(results);
