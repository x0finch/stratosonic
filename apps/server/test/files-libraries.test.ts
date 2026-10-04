import { SELF } from "cloudflare:test";
import { playlist, property } from "@stratosonic/db";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_CALLS,
  CHECK_ENTRIES,
  CHECK_LISTINGS,
  FOLDER_DELETE_PAGE,
  S3_CHECK_ENTRIES,
  S3_DELETE_CALLS,
  S3_FOLDER_DELETE_PAGE,
} from "../src/api/files";
import { database } from "../src/db";
import { forgetUploadsWarning } from "../src/files/config";
import { presignUpload, r2Endpoint } from "../src/storage/presign";
import { type CookieJar, cost, seedConsoleUser, shape, signIn } from "./console-auth-support";
import { FakeS3, installFakeS3 } from "./fake-s3";
import {
  boundTarget,
  connectFakeLibrary,
  emptyFakeBucket,
  type FilesTarget,
  fakeKeys,
  fakeTarget,
  seedFakeObjects,
} from "./files-libraries-support";
import { allKeys, type FilesHarness, filesHarness, UPLOADS_ENV } from "./files-support";
import { seedLibraryPlaylist } from "./libraries-support";
import { resetLibrary } from "./scan-support";
import { canonicalObjectPath, oracleSignature } from "./sigv4-oracle";
import { BASE, testEnv } from "./support";

/**
 * The Files API across libraries (#84, "Files across libraries"; ticket H):
 * Phase 2's route tests (files-api, files-uploads, files-uploads-check) run
 * again on library 1, the binding, and on library 2, a bucket over the S3
 * API answered by the fake (test/fake-s3.ts), with the library named in
 * every request; then library 2's own rules: no reserved prefix, the
 * refusals, its presigned URLs, the S3 limits, keys with a control
 * character, and playlist rows by `(library_id, r2_key)`.
 *
 * Requests that name no library are Phase 2's own tests, unchanged.
 */

const ORIGIN = "https://files-libraries.stratosonic.test";
const harness = filesHarness(ORIGIN, { uploads: UPLOADS_ENV });

const fake = new FakeS3();
/** A second account, for the read-only library (paths are unique). */
const readOnlyFake = new FakeS3({
  accountId: "abcdef0123456789abcdef0123456789",
  bucket: "readonly",
});

const ARCHIVE = { id: 2, name: "Archive" } as const;
const READ_ONLY = { id: 3, name: "Read Only" } as const;
const LEAVING = { id: 4, name: "Leaving" } as const;
/** A library whose bucket the fake does not have. */
const GONE = { id: 5, name: "Gone" } as const;

const TARGETS: readonly FilesTarget[] = [boundTarget(() => harness), fakeTarget(ARCHIVE.id, fake)];

let owner: CookieJar;

beforeAll(async () => {
  // The bootstrap's Subsonic admin, which a playlist row is owned by.
  await SELF.fetch(`${BASE}/rest/ping`);
  await seedConsoleUser("owner", "libraries");
  owner = (await signIn(harness.send, ORIGIN, "owner", "libraries")).jar;

  await connectFakeLibrary({ ...ARCHIVE, fake });
  await connectFakeLibrary({ ...READ_ONLY, fake: readOnlyFake, writable: false });
  await connectFakeLibrary({ ...LEAVING, fake, bucket: "leaving", state: "removing" });
  await connectFakeLibrary({ ...GONE, fake, bucket: "gone" });
});

beforeEach(async () => {
  await resetLibrary();
  const left = await allKeys();
  for (let start = 0; start < left.length; start += 1000) {
    await testEnv.MUSIC.delete(left.slice(start, start + 1000));
  }
  await emptyFakeBucket();
  installFakeS3(fake, readOnlyFake);
  fake.pageLimit = null;
  fake.fail(null);
  fake.calls.length = 0;
  readOnlyFake.calls.length = 0;
  harness.r2Calls.length = 0;
  harness.driverCalls.length = 0;
  for (const target of TARGETS) {
    target.resetCalls();
  }
  forgetUploadsWarning();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** `scan` from the inert driver: a pass at some time. */
const SCHEDULED = {
  scheduledAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
  afterCurrentPass: false,
};

interface Listing {
  prefix: string;
  folders: { name: string; prefix: string }[];
  files: { name: string; key: string; size: number; uploadedAt: string; kind: string }[];
  cursor: string | null;
}

interface Signed {
  key: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  expiresAt: string;
}

interface Refused {
  key: string;
  error: string;
  existing?: { size: number; uploadedAt: string };
}

type UploadResult = Signed | Refused;

async function json<T>(response: Response | Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}

async function libraryChangedAt(): Promise<number | null> {
  const [row] = await database(testEnv)
    .select()
    .from(property)
    .where(eq(property.id, "LibraryChangedAt"));
  return row === undefined ? null : (JSON.parse(row.value) as { at: number }).at;
}

async function playlistRows() {
  return database(testEnv)
    .select({ libraryId: playlist.libraryId, r2Key: playlist.r2Key })
    .from(playlist)
    .orderBy(asc(playlist.libraryId), asc(playlist.r2Key));
}

/**
 * An object's upload time as a `head()` of the library answers it: to the
 * millisecond through the binding, and to the second over the S3 API
 * (`Last-Modified`).
 */
function headTime(target: FilesTarget, uploaded: Date | undefined): string | undefined {
  if (uploaded === undefined) {
    return undefined;
  }
  const at =
    target.library === 1 ? uploaded.getTime() : Math.floor(uploaded.getTime() / 1000) * 1000;
  return new Date(at).toISOString();
}

/** Where a target's uploads go: its bucket's path-style root. */
function bucketRoot(target: FilesTarget): string {
  return target.library === 1
    ? `${r2Endpoint(UPLOADS_ENV.CF_ACCOUNT_ID)}/${UPLOADS_ENV.R2_BUCKET_NAME}/`
    : `${fake.endpoint}/${fake.bucket}/`;
}

/* ================================================ the routes, per library == */

describe.each(TARGETS)("the Files routes on $name", (target) => {
  /** A harness of library 1 with this page, or library 2's fake given it. */
  function paged(limit: number, options: Parameters<typeof filesHarness>[1] = {}): FilesHarness {
    if (target.library === 1) {
      return filesHarness(ORIGIN, { uploads: UPLOADS_ENV, listLimit: limit, ...options });
    }
    fake.pageLimit = limit;
    return harness;
  }

  describe("GET /api/files", () => {
    it("lists a folder's folders and files, without the library's reserved prefixes, in one listing", async () => {
      await target.seed([
        "Root.mp3",
        "Artist/Album/01 Song.flac",
        "Artist/Album/cover.JPG",
        "_covers/abc.png",
        "playlists/mix.m3u",
      ]);
      // A zero-byte folder marker, as some S3 tools write.
      await target.put("Artist/Album/", new Uint8Array());
      target.resetCalls();

      const root = await json<Listing>(harness.call(owner, "GET", `/files?${target.query({})}`));

      expect(root.folders.map((folder) => folder.prefix)).toEqual(
        ["Artist/", "_covers/", "playlists/"].filter((folder) => !target.reserved.includes(folder)),
      );
      expect(root.files).toEqual([
        {
          name: "Root.mp3",
          key: "Root.mp3",
          size: "bytes of Root.mp3".length,
          uploadedAt: (await target.head("Root.mp3"))?.uploaded.toISOString(),
          kind: "audio",
        },
      ]);
      expect(root.cursor).toBeNull();

      const album = await json<Listing>(
        harness.call(owner, "GET", `/files?${target.query({ prefix: "Artist/Album/" })}`),
      );
      expect(album.files.map(({ name, kind }) => ({ name, kind }))).toEqual([
        { name: "01 Song.flac", kind: "audio" },
        { name: "cover.JPG", kind: "image" },
      ]);
      expect(target.calls()).toEqual(["list", "list"]);
    });

    it("pages with the bucket's cursor, and the next page carries on", async () => {
      await target.seed(["P/a.mp3", "P/b.mp3", "P/c.mp3", "P/d/e.mp3", "P/f.lrc"]);
      const on = paged(2);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query = target.query(cursor === null ? { prefix: "P/" } : { prefix: "P/", cursor });
        const listing: Listing = await json<Listing>(on.call(owner, "GET", `/files?${query}`));
        seen.push(...listing.folders.map((folder) => folder.prefix));
        seen.push(...listing.files.map((file) => file.key));
        cursor = listing.cursor;
        pages++;
      } while (cursor !== null && pages < 10);

      expect(pages).toBeGreaterThan(1);
      expect(seen.sort()).toEqual(["P/a.mp3", "P/b.mp3", "P/c.mp3", "P/d/", "P/f.lrc"]);
    });

    it("answers 400 invalid_cursor to a cursor the bucket refuses, not 500", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      // The fake refuses a token it never issued, as S3 does; the binding's
      // harness stands in for R2's refusal.
      const on = target.library === 1 ? filesHarness(ORIGIN, { refusedCursor: "forged" }) : harness;

      const response = await on.call(
        owner,
        "GET",
        `/files?${target.query({ prefix: "P/", cursor: "forged" })}`,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_cursor" });
    });

    it("answers 500 to a listing that fails without a cursor", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const on = target.library === 1 ? filesHarness(ORIGIN, { failListing: true }) : harness;
      fake.fail("server_error", ["ListObjectsV2"]);

      const response = await on.call(owner, "GET", `/files?${target.query({ prefix: "P/" })}`);

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal" });
    });
  });

  describe("POST /api/files/delete", () => {
    const KEYS = ["Artist/Album/01 Song.flac", "Artist/Album/01 Song.lrc"];
    const KEPT = ["Artist/Album/02 Next.flac", "Other/01.mp3"];

    it("deletes the keys in one call, counting each distinct key once, and schedules a pass", async () => {
      await target.seed([...KEYS, ...KEPT]);
      target.resetCalls();

      const response = await harness.call(
        owner,
        "POST",
        "/files/delete",
        target.body({ keys: [KEYS[0], KEYS[0], KEYS[1], "Artist/Album/missing.flac"] }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ deleted: 3, scan: SCHEDULED });
      expect(await target.keys()).toEqual([...KEPT].sort());
      expect(target.calls()).toEqual(["delete"]);
      expect(await libraryChangedAt()).not.toBeNull();
      expect(harness.driverCalls).toEqual(["touch"]);
    });

    it("takes 250 keys in one call", async () => {
      const keys = Array.from({ length: 250 }, (_, index) => `Many/${index}.flac`);

      const response = await harness.call(owner, "POST", "/files/delete", target.body({ keys }));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ deleted: 250 });
      expect(target.calls()).toEqual(["delete"]);
    });

    it("takes a deleted playlist's row out of its own library only", async () => {
      const other = target.library === 1 ? ARCHIVE.id : 1;
      await seedLibraryPlaylist(target.library, "Mixes/road.m3u", "files-owner");
      await seedLibraryPlaylist(other, "Mixes/road.m3u", "files-owner");
      await target.seed(["Mixes/road.m3u"]);

      const response = await harness.call(
        owner,
        "POST",
        "/files/delete",
        target.body({ keys: ["Mixes/road.m3u"] }),
      );

      expect(response.status).toBe(200);
      expect(await playlistRows()).toEqual([{ libraryId: other, r2Key: "Mixes/road.m3u" }]);
    });
  });

  describe("POST /api/files/delete-folder", () => {
    it("deletes a folder in rounds until done, at every depth, and nothing outside it", async () => {
      await target.seed([
        "Small/a.mp3",
        "Small/b.mp3",
        "Small/c/d.mp3",
        "Small/e.lrc",
        "Small/f.txt",
        "Smaller.mp3",
      ]);
      const on = paged(2);

      const rounds: unknown[] = [];
      for (let round = 0; round < 5; round++) {
        const body = await json<{ deleted: number; done: boolean; scan?: unknown }>(
          on.call(owner, "POST", "/files/delete-folder", target.body({ prefix: "Small/" })),
        );
        rounds.push(body);
        if (body.done) {
          break;
        }
      }

      expect(rounds).toEqual([
        { deleted: 4, done: false, scan: SCHEDULED },
        { deleted: 1, done: true, scan: SCHEDULED },
      ]);
      expect(await target.keys()).toEqual(["Smaller.mp3"]);

      // A folder already gone: nothing deleted, nothing recorded, no `scan`.
      const again = await on.call(
        owner,
        "POST",
        "/files/delete-folder",
        target.body({ prefix: "Small/" }),
      );
      expect(await again.json()).toEqual({ deleted: 0, done: true });
    });

    it("accounts for the first page when the second delete fails, then answers 500", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const on = paged(2, { failDeleteCall: 2 });
      if (target.library !== 1) {
        fake.failCall("DeleteObjects", 2, "server_error");
      }
      await seedLibraryPlaylist(target.library, "Half/0-mix.m3u", "files-owner");
      await target.seed(["Half/0-mix.m3u", "Half/a.txt", "Half/b.txt", "Half/c.txt"]);

      const response = await on.call(
        owner,
        "POST",
        "/files/delete-folder",
        target.body({ prefix: "Half/" }),
      );

      expect(response.status).toBe(500);
      expect(await target.keys("Half/")).toEqual(["Half/b.txt", "Half/c.txt"]);
      expect(await playlistRows()).toEqual([]);
      expect(await libraryChangedAt()).not.toBeNull();
    });
  });

  describe("POST /api/files/uploads", () => {
    it("signs a new file with If-None-Match, answers exists for a stored one, and signs its Replace without", async () => {
      await target.put("Artist/Album/cover.jpg", new Uint8Array(183));
      const stored = await target.head("Artist/Album/cover.jpg");
      target.resetCalls();

      const { uploads } = await json<{ uploads: UploadResult[] }>(
        harness.call(
          owner,
          "POST",
          "/files/uploads",
          target.body({
            files: [
              { key: "Artist/Album/01 Title.flac", size: 41_234_567 },
              { key: "Artist/Album/cover.jpg", size: 99 },
              { key: "Artist/Album/cover.jpg", size: 99, overwrite: true },
            ],
          }),
        ),
      );

      expect(uploads).toEqual([
        {
          key: "Artist/Album/01 Title.flac",
          url: expect.stringContaining(`${bucketRoot(target)}Artist/Album/01%20Title.flac?`),
          method: "PUT",
          headers: { "Content-Type": "audio/flac", "If-None-Match": "*" },
          expiresAt: expect.any(String),
        },
        {
          key: "Artist/Album/cover.jpg",
          error: "exists",
          existing: { size: 183, uploadedAt: headTime(target, stored?.uploaded) },
        },
        {
          key: "Artist/Album/cover.jpg",
          url: expect.stringContaining(`${bucketRoot(target)}Artist/Album/cover.jpg?`),
          method: "PUT",
          headers: { "Content-Type": "image/jpeg" },
          expiresAt: expect.any(String),
        },
      ]);
      const calls = target.calls();
      expect(calls.filter((call) => call === "head")).toHaveLength(3);
      // Over the S3 API, one listing proves the bucket before a new key is trusted.
      expect(calls.filter((call) => call === "list")).toHaveLength(target.library === 1 ? 0 : 1);
      expect(harness.driverCalls).toEqual([]);
      expect(await libraryChangedAt()).toBeNull();
    });

    it("answers each per-file error without failing the others, and heads only what passed", async () => {
      const { uploads } = await json<{ uploads: UploadResult[] }>(
        harness.call(
          owner,
          "POST",
          "/files/uploads",
          target.body({
            files: [
              { key: "A/../x.flac", size: 1 },
              { key: "A/setup.exe", size: 1 },
              { key: "A/empty.flac", size: 0 },
              { key: "A/huge.lrc", size: 2_000_000 },
              { key: "A/ok.flac", size: 1 },
            ],
          }),
        ),
      );

      expect(uploads.map((upload) => ("error" in upload ? upload.error : "signed"))).toEqual([
        "invalid_path",
        "type_not_allowed",
        "empty_file",
        "too_large",
        "signed",
      ]);
      expect(target.calls().filter((call) => call === "head")).toHaveLength(1);
    });
  });

  describe("POST /api/files/uploads/check", () => {
    it("answers the keys that exist, with the stored size and time, in one listing a folder", async () => {
      await target.seed(["Album/01.flac", "Album/03.lrc", "Other/x.flac"]);
      const stored = await target.head("Album/01.flac");
      target.resetCalls();

      const response = await harness.call(
        owner,
        "POST",
        "/files/uploads/check",
        target.body({ keys: ["Album/01.flac", "Album/02.flac", "Album/03.lrc"] }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        existing: [
          {
            key: "Album/01.flac",
            storedKey: "Album/01.flac",
            size: "bytes of Album/01.flac".length,
            uploadedAt: stored?.uploaded.toISOString(),
          },
          {
            key: "Album/03.lrc",
            storedKey: "Album/03.lrc",
            size: "bytes of Album/03.lrc".length,
            uploadedAt: expect.any(String),
          },
        ],
        unchecked: [],
      });
      expect(target.calls()).toEqual(["list"]);
    });

    it("looks past the listings with the calls left, and answers the rest unchecked", async () => {
      await target.seed([`F${CHECK_LISTINGS + 1}/a.flac`]);
      target.resetCalls();
      const keys = Array.from({ length: CHECK_LISTINGS + 10 }, (_, index) => `F${index}/a.flac`);

      const body = await json<{ existing: { key: string }[]; unchecked: string[] }>(
        harness.call(owner, "POST", "/files/uploads/check", target.body({ keys })),
      );

      const calls = target.calls();
      expect(calls.filter((call) => call === "list")).toHaveLength(CHECK_LISTINGS);
      expect(calls.filter((call) => call === "head")).toHaveLength(CHECK_CALLS - CHECK_LISTINGS);
      expect(body.existing.map((entry) => entry.key)).toEqual([`F${CHECK_LISTINGS + 1}/a.flac`]);
      expect(body.unchecked).toEqual(keys.slice(CHECK_CALLS));
    });
  });

  describe("POST /api/files/uploads/complete", () => {
    it("records the change and tells the driver, with no storage call", async () => {
      const response = await harness.call(
        owner,
        "POST",
        "/files/uploads/complete",
        target.body({ keys: ["Album/01.flac", "Album/01.lrc"] }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ scan: SCHEDULED });
      expect(target.calls()).toEqual([]);
      expect(harness.driverCalls).toEqual(["touch"]);
      expect(await libraryChangedAt()).not.toBeNull();
    });
  });
});

/* ======================================================= library 2's rules == */

describe("the reserved prefix", () => {
  it("is library 1's only: _covers/ is browsed, deleted, uploaded and completed in library 2", async () => {
    await seedFakeObjects(["_covers/a.jpg", "_covers/b/c.jpg", "_covers/d.jpg"]);
    const body = (fields: Record<string, unknown>) => ({ library: ARCHIVE.id, ...fields });

    const listed = await json<Listing>(
      harness.call(owner, "GET", "/files?library=2&prefix=_covers%2F"),
    );
    expect(listed.files.map((file) => file.key)).toEqual(["_covers/a.jpg", "_covers/d.jpg"]);

    const deleted = await harness.call(
      owner,
      "POST",
      "/files/delete",
      body({ keys: ["_covers/a.jpg"] }),
    );
    expect(deleted.status).toBe(200);
    const folder = await harness.call(
      owner,
      "POST",
      "/files/delete-folder",
      body({ prefix: "_covers/b/" }),
    );
    expect(await folder.json()).toMatchObject({ deleted: 1, done: true });

    const signed = await json<{ uploads: UploadResult[] }>(
      harness.call(
        owner,
        "POST",
        "/files/uploads",
        body({ prefix: "_covers/", files: [{ key: "_covers/e.jpg", size: 10 }] }),
      ),
    );
    expect(signed.uploads[0]).toHaveProperty("url");

    const checked = await harness.call(
      owner,
      "POST",
      "/files/uploads/check",
      body({ prefix: "_covers/", keys: ["_covers/d.jpg"] }),
    );
    expect(await checked.json()).toMatchObject({ existing: [{ key: "_covers/d.jpg" }] });

    const completed = await harness.call(
      owner,
      "POST",
      "/files/uploads/complete",
      body({ keys: ["_covers/e.jpg"] }),
    );
    expect(completed.status).toBe(200);
    expect(await fakeKeys()).toEqual(["_covers/d.jpg"]);
  });

  it("is still refused in library 1 when the request names it", async () => {
    await testEnv.MUSIC.put("_covers/a.jpg", "cover");
    const responses = [
      await harness.call(owner, "GET", "/files?library=1&prefix=_covers%2F"),
      await harness.call(owner, "POST", "/files/delete", { library: 1, keys: ["_covers/a.jpg"] }),
      await harness.call(owner, "POST", "/files/delete-folder", {
        library: 1,
        prefix: "_covers/",
      }),
      await harness.call(owner, "POST", "/files/uploads/complete", {
        library: 1,
        keys: ["_covers/a.jpg"],
      }),
    ];

    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "reserved_path" });
    }
    expect(await allKeys()).toEqual(["_covers/a.jpg"]);
  });
});

/** Every write route, with a body that would pass but for its library. */
const WRITES: readonly [string, Record<string, unknown>][] = [
  ["/files/delete", { keys: ["A/1.mp3"] }],
  ["/files/delete-folder", { prefix: "A/" }],
  ["/files/uploads", { files: [{ key: "A/2.mp3", size: 10 }] }],
  ["/files/uploads/check", { keys: ["A/2.mp3"] }],
  ["/files/uploads/complete", { keys: ["A/2.mp3"] }],
];

/**
 * That a request is refused with this status and error, and changes
 * nothing: no D1 row written, no object of either bucket touched, no call to
 * the fake or the driver.
 */
async function expectRefused(
  request: () => Promise<Response>,
  status: number,
  error: string,
): Promise<void> {
  const keys = await fakeKeys();
  const bound = await allKeys();
  const calls = fake.calls.length + readOnlyFake.calls.length;
  harness.d1.reset();
  harness.r2Calls.length = 0;
  harness.driverCalls.length = 0;

  const response = await request();

  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
  expect(cost(harness.d1.statements).rowsWritten).toBe(0);
  expect(fake.calls.length + readOnlyFake.calls.length).toBe(calls);
  expect(harness.r2Calls).toEqual([]);
  expect(harness.driverCalls).toEqual([]);
  expect(await fakeKeys()).toEqual(keys);
  expect(await allKeys()).toEqual(bound);
}

describe("library_not_found", () => {
  beforeEach(async () => {
    await seedFakeObjects(["A/1.mp3"]);
  });

  it.each([
    ["an unknown library", 99],
    ["a library being removed", LEAVING.id],
    ["no library at all", 0],
  ])("answers 404 on every route for %s", async (_, id) => {
    await expectRefused(
      () => harness.call(owner, "GET", `/files?library=${id}`),
      404,
      "library_not_found",
    );
    for (const [path, body] of WRITES) {
      await expectRefused(
        () => harness.call(owner, "POST", path, { library: id, ...body }),
        404,
        "library_not_found",
      );
    }
  });

  it.each(["abc", "2.5", "-2", "02", ""])(
    "answers 404 to ?library=%j, which names none",
    async (value) => {
      await expectRefused(
        () => harness.call(owner, "GET", `/files?library=${encodeURIComponent(value)}`),
        404,
        "library_not_found",
      );
    },
  );

  it.each([
    ["a string", "2"],
    ["a fraction", 2.5],
    ["null", null],
  ])("answers 400 invalid_request to a body's library that is %s", async (_, library) => {
    for (const [path, body] of WRITES) {
      await expectRefused(
        () => harness.call(owner, "POST", path, { library, ...body }),
        400,
        "invalid_request",
      );
    }
  });
});

describe("library_read_only", () => {
  it("answers 403 to every write, and still browses", async () => {
    await seedFakeObjects(["A/1.mp3"]);
    for (const [path, body] of WRITES) {
      await expectRefused(
        () => harness.call(owner, "POST", path, { library: READ_ONLY.id, ...body }),
        403,
        "library_read_only",
      );
    }

    const listing = await json<Listing>(harness.call(owner, "GET", "/files?library=3"));
    expect(listing.folders).toEqual([{ name: "A", prefix: "A/" }]);
    expect(readOnlyFake.calls.map((call) => call.operation)).toEqual(["ListObjectsV2"]);
  });
});

describe("FILE_WRITES off", () => {
  it("refuses library 2's writes before its library is read", async () => {
    const preview = filesHarness(ORIGIN, { fileWrites: "off" });
    for (const [path, body] of WRITES) {
      preview.d1.reset();
      const response = await preview.call(owner, "POST", path, { library: ARCHIVE.id, ...body });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "file_writes_disabled" });
      expect(preview.d1.statements.map(shape)).not.toContain("select library");
    }
    expect(fake.calls).toEqual([]);
  });
});

describe("GET /api/files/config", () => {
  it("lists the active libraries, with what the Files page may do in each", async () => {
    // No Phase 2 secrets: library 1's uploads are off, a connected library's on.
    const unset = filesHarness(ORIGIN);

    const config = await json<{ libraries: unknown[] }>(unset.call(owner, "GET", "/files/config"));

    expect(config.libraries).toEqual([
      {
        id: 1,
        name: "Music Library",
        writable: true,
        uploads: {
          configured: false,
          missing: ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "CF_ACCOUNT_ID"],
        },
        reservedPrefixes: ["_covers/"],
      },
      {
        id: 2,
        name: "Archive",
        writable: true,
        uploads: { configured: true },
        reservedPrefixes: [],
      },
      {
        id: 3,
        name: "Read Only",
        writable: false,
        uploads: { configured: true },
        reservedPrefixes: [],
      },
      { id: 5, name: "Gone", writable: true, uploads: { configured: true }, reservedPrefixes: [] },
    ]);
    expect(fake.calls).toEqual([]);
  });

  it("signs a connected library's uploads with its stored token, where library 1's are not configured", async () => {
    const unset = filesHarness(ORIGIN);
    const files = [{ key: "A/1.mp3", size: 10 }];

    const bound = await unset.call(owner, "POST", "/files/uploads", { files });
    expect(bound.status).toBe(503);
    expect(await bound.json()).toEqual({ error: "uploads_not_configured" });

    const connected = await json<{ uploads: UploadResult[] }>(
      unset.call(owner, "POST", "/files/uploads", { library: ARCHIVE.id, files }),
    );
    expect(connected.uploads[0]).toHaveProperty("url");
  });
});

/* ===================================================== presigned uploads == */

describe("upload URLs", () => {
  /** The SigV4 oracle's signature for a presigned `PUT`, from the URL's own parameters. */
  async function oracleFor(
    upload: Signed,
    size: number,
    location: { host: string; bucket: string; secretAccessKey: string },
  ): Promise<string> {
    const url = new URL(upload.url);
    const query = Object.fromEntries(
      [...url.searchParams].filter(([name]) => name !== "X-Amz-Signature"),
    );
    const headers: Record<string, string> = {
      "content-length": String(size),
      "content-type": upload.headers["Content-Type"] ?? "",
    };
    if (upload.headers["If-None-Match"] !== undefined) {
      headers["if-none-match"] = upload.headers["If-None-Match"];
    }
    return oracleSignature({
      method: "PUT",
      host: location.host,
      canonicalPath: canonicalObjectPath(location.bucket, upload.key),
      query,
      headers,
      secretAccessKey: location.secretAccessKey,
      amzDate: query["X-Amz-Date"] ?? "",
      region: "auto",
      service: "s3",
    });
  }

  it("verifies a library-2 upload under the oracle, with its endpoint, bucket and key", async () => {
    const old = "Björk/Homogenic/02 Old.flac".normalize("NFC");
    await seedFakeObjects([old]);
    const keys = ["Björk/Homogenic/01 Jóga.flac".normalize("NFC"), "AC+DC/It's #1 & 100%.mp3"];
    const files = [
      ...keys.map((key) => ({ key, size: 41_234_567 })),
      { key: old, size: 5, overwrite: true },
    ];

    const { uploads } = await json<{ uploads: Signed[] }>(
      harness.call(owner, "POST", "/files/uploads", { library: ARCHIVE.id, files }),
    );

    expect(uploads.map((upload) => upload.key)).toEqual([...keys, old]);
    expect(uploads[2]?.headers).toEqual({ "Content-Type": "audio/flac" });
    for (const [index, upload] of uploads.entries()) {
      const url = new URL(upload.url);
      expect(url.host).toBe(fake.host);
      expect(url.pathname).toBe(canonicalObjectPath(fake.bucket, upload.key));
      expect(url.searchParams.get("X-Amz-Credential")).toMatch(
        new RegExp(`^${fake.accessKeyId}/\\d{8}/auto/s3/aws4_request$`),
      );
      expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
      expect(url.searchParams.get("X-Amz-Signature")).toBe(
        await oracleFor(upload, files[index]?.size ?? 0, {
          host: fake.host,
          bucket: fake.bucket,
          secretAccessKey: fake.secretAccessKey,
        }),
      );
    }
    // The secret signs, and is in no answer.
    expect(JSON.stringify(uploads)).not.toContain(fake.secretAccessKey);
  });

  it("keeps library 1's URL byte for byte, whether the request names library 1 or none", async () => {
    const files = [{ key: "Artist/Album/01 Title.flac", size: 41_234_567 }];

    for (const body of [{ files }, { library: 1, files }]) {
      const { uploads } = await json<{ uploads: Signed[] }>(
        harness.call(owner, "POST", "/files/uploads", body),
      );
      const upload = uploads[0] as Signed;
      const amzDate = new URL(upload.url).searchParams.get("X-Amz-Date") ?? "";
      const signedAt = Date.UTC(
        Number(amzDate.slice(0, 4)),
        Number(amzDate.slice(4, 6)) - 1,
        Number(amzDate.slice(6, 8)),
        Number(amzDate.slice(9, 11)),
        Number(amzDate.slice(11, 13)),
        Number(amzDate.slice(13, 15)),
      );
      // Phase 2's presign, with Phase 2's secrets, for the same instant.
      const expected = await presignUpload(
        {
          libraryId: 1,
          endpoint: r2Endpoint(UPLOADS_ENV.CF_ACCOUNT_ID),
          bucket: UPLOADS_ENV.R2_BUCKET_NAME,
          credentials: {
            accessKeyId: UPLOADS_ENV.R2_ACCESS_KEY_ID,
            secretAccessKey: UPLOADS_ENV.R2_SECRET_ACCESS_KEY,
          },
        },
        { key: files[0]?.key ?? "", size: 41_234_567, contentType: "audio/flac", replace: false },
        signedAt,
      );
      expect(upload).toEqual({ key: files[0]?.key, ...expected });
    }
    expect(fake.calls).toEqual([]);
  });
});

/* ================================================= a failing bucket ====== */

describe("a connected bucket that fails a browse with a cursor", () => {
  it("answers 500 for a refused token, keeping invalid_cursor for the cursor's own refusal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fake.fail("access_denied", ["ListObjectsV2"]);

    const response = await harness.call(owner, "GET", "/files?library=2&prefix=P%2F&cursor=c");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
  });
});

describe("a connected library whose bucket is missing", () => {
  it("fails an upload rather than signing a new key on a null head()", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await harness.call(owner, "POST", "/files/uploads", {
      library: GONE.id,
      files: [{ key: "A/1.mp3", size: 10 }],
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    // The head() read the bucket's 404 as a missing key; the listing did not.
    expect(fake.calls.map((call) => [call.operation, call.status])).toEqual([
      ["HeadObject", 404],
      ["ListObjectsV2", 404],
    ]);
  });

  it("fails an upload check at its first listing, before any head()", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await harness.call(owner, "POST", "/files/uploads/check", {
      library: GONE.id,
      keys: ["A/1.mp3"],
    });

    expect(response.status).toBe(500);
    expect(fake.calls.map((call) => call.operation)).toEqual(["ListObjectsV2"]);
  });
});

/* ===================================================== the S3 limits ====== */

describe("the S3 limits", () => {
  it("are 46 storage calls for every check, and 1,000 entries and pages of 500 over the S3 API", () => {
    expect(CHECK_CALLS).toBe(46);
    expect(CHECK_ENTRIES).toBe(2000);
    expect(S3_CHECK_ENTRIES).toBe(1000);
    expect(FOLDER_DELETE_PAGE).toBe(1000);
    expect(S3_FOLDER_DELETE_PAGE).toBe(500);
    expect(S3_DELETE_CALLS).toBe(40);
  });

  describe("on a folder of 1,001 objects", { timeout: 60_000 }, () => {
    const BIG = [
      ...Array.from({ length: 1000 }, (_, index) => `Big/${String(index).padStart(4, "0")}.flac`),
      "Big/zzzz.flac",
    ];

    beforeEach(async () => {
      await seedFakeObjects(BIG, 100);
      fake.calls.length = 0;
    });

    it("a delete-folder round lists two pages of 500, and reaches 1,000 keys", async () => {
      const first = await harness.call(owner, "POST", "/files/delete-folder", {
        library: ARCHIVE.id,
        prefix: "Big/",
      });

      expect(await first.json()).toMatchObject({ deleted: 1000, done: false });
      expect(
        fake.calls.map((call) =>
          call.operation === "ListObjectsV2"
            ? `list ${new URL(call.url).searchParams.get("max-keys")}`
            : `${call.operation} ${call.keys}`,
        ),
      ).toEqual(["list 500", "DeleteObjects 500", "list 500", "DeleteObjects 500"]);

      const second = await harness.call(owner, "POST", "/files/delete-folder", {
        library: ARCHIVE.id,
        prefix: "Big/",
      });
      expect(await second.json()).toMatchObject({ deleted: 1, done: true });
      expect(await fakeKeys()).toEqual([]);
    });

    it("an upload check lists 1,000 entries, then looks for the rest with head()", async () => {
      const response = await harness.call(owner, "POST", "/files/uploads/check", {
        library: ARCHIVE.id,
        keys: ["Big/zzzz.flac"],
      });

      expect(await response.json()).toMatchObject({
        existing: [{ key: "Big/zzzz.flac", storedKey: "Big/zzzz.flac" }],
        unchecked: [],
      });
      expect(
        fake.calls.map((call) =>
          call.operation === "ListObjectsV2"
            ? `list ${new URL(call.url).searchParams.get("max-keys")}`
            : call.operation,
        ),
      ).toEqual(["list 1000", "HeadObject"]);
    });

    it("browse still lists a page of 1,000", async () => {
      const listing = await json<Listing>(
        harness.call(owner, "GET", "/files?library=2&prefix=Big%2F"),
      );

      expect(listing.files).toHaveLength(1000);
      expect(listing.cursor).not.toBeNull();
    });
  });
});

/* ===================================================== control characters == */

describe("keys with a control character", () => {
  const control = (index: number) => `Ctl/${String(index).padStart(2, "0")}\u0001.flac`;

  it("are deleted each with its own DeleteObject, the rest in one DeleteObjects", async () => {
    await seedFakeObjects([control(1), "Ctl/plain.flac", "Ctl/kept.flac"]);
    fake.calls.length = 0;

    const response = await harness.call(owner, "POST", "/files/delete", {
      library: ARCHIVE.id,
      keys: [control(1), "Ctl/plain.flac"],
    });

    expect(await response.json()).toMatchObject({ deleted: 2 });
    expect(fake.calls.map((call) => [call.operation, call.key ?? call.keys])).toEqual([
      ["DeleteObjects", 1],
      ["DeleteObject", control(1)],
    ]);
    expect(await fakeKeys()).toEqual(["Ctl/kept.flac"]);
  });

  it("past the requests a delete may make, refuse it with too_many_keys, deleting nothing", async () => {
    const keys = Array.from({ length: S3_DELETE_CALLS }, (_, index) => control(index));
    await seedFakeObjects(keys);

    await expectRefused(
      () =>
        harness.call(owner, "POST", "/files/delete", {
          library: ARCHIVE.id,
          keys: [...keys, "Ctl/plain.flac"],
        }),
      400,
      "too_many_keys",
    );

    // One fewer fits: 39 alone and one DeleteObjects.
    const fits = await harness.call(owner, "POST", "/files/delete", {
      library: ARCHIVE.id,
      keys: [...keys.slice(1), "Ctl/plain.flac"],
    });
    expect(fits.status).toBe(200);
    expect(await fakeKeys()).toEqual([control(0)]);
  });

  it("are deleted from a folder in rounds of at most 40 requests, until done", async () => {
    await seedFakeObjects([
      ...Array.from({ length: 50 }, (_, index) => control(index)),
      "Ctl/plain.flac",
    ]);

    const rounds: unknown[] = [];
    for (let round = 0; round < 5; round++) {
      fake.calls.length = 0;
      const body = await json<{ deleted: number; done: boolean }>(
        harness.call(owner, "POST", "/files/delete-folder", {
          library: ARCHIVE.id,
          prefix: "Ctl/",
        }),
      );
      expect(fake.calls.length).toBeLessThanOrEqual(S3_DELETE_CALLS);
      rounds.push({ deleted: body.deleted, done: body.done });
      if (body.done) {
        break;
      }
    }

    // A listing, then 39 keys alone; then a listing, 11 alone and one DeleteObjects.
    expect(rounds).toEqual([
      { deleted: 39, done: false },
      { deleted: 12, done: true },
    ]);
    expect(await fakeKeys()).toEqual([]);
  });
});

/* ============================================================ the fast path == */

describe("library 1", () => {
  it("reads no library row, whether the request names it or not", async () => {
    await seedFakeObjects(["A/1.mp3"]);
    await testEnv.MUSIC.put("A/1.mp3", "bytes");
    const statements: string[][] = [];
    for (const [query, body] of [
      ["", {}],
      ["?library=1", { library: 1 }],
    ] as const) {
      harness.d1.reset();
      await harness.call(owner, "GET", `/files${query}`);
      await harness.call(owner, "POST", "/files/uploads/check", { ...body, keys: ["A/1.mp3"] });
      await harness.call(owner, "POST", "/files/delete", { ...body, keys: ["A/1.mp3"] });
      statements.push(harness.d1.statements.map(shape));
    }

    expect(statements[0]).not.toContain("select library");
    expect(statements[1]).toEqual(statements[0]);
    expect(fake.calls).toEqual([]);
  });

  it("is the library a body's missing library means, never library 2", async () => {
    await seedFakeObjects(["A/1.mp3"]);
    await testEnv.MUSIC.put("A/1.mp3", "bytes");

    const response = await harness.call(owner, "POST", "/files/delete", { keys: ["A/1.mp3"] });

    expect(response.status).toBe(200);
    expect(await allKeys()).toEqual([]);
    expect(await fakeKeys()).toEqual(["A/1.mp3"]);
  });
});
