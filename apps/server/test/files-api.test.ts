import { SELF } from "cloudflare:test";
import { playlist, playlistTrack, property } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE_BATCH } from "../src/api/files";
import { MAX_FILE_DELETE_BODY_BYTES, MAX_JSON_BODY_BYTES } from "../src/api/json-body";
import { database } from "../src/db";
import { ALLOWED, MAX_KEY_BYTES, MAX_SEGMENT_BYTES } from "../src/files/keys";
import { RESCAN_QUIET_MS } from "../src/files/library-change";
import { type CookieJar, GUEST_ROLE, seedConsoleUser, signIn } from "./console-auth-support";
import { nextAlarmAt, poke, storedKeys } from "./driver-support";
import {
  allKeys,
  expectRefusal,
  type FilesHarness,
  filesHarness,
  inertDriver,
  resetDriver,
  rows,
  seedObjects,
  unreachableDriver,
} from "./files-support";
import { resetLibrary } from "./scan-support";
import { BASE, seedPlaylist, testEnv } from "./support";

/**
 * The Files API (#83, #131): `GET /api/files/config`, `GET /api/files`,
 * `POST /api/files/delete` and `POST /api/files/delete-folder`, through the
 * Worker's app, over the real D1, R2 and scan driver of the pool, each
 * recorded by the harness (test/files-support.ts).
 *
 * D1, R2 and the driver are shared by the tests of this file, so each test
 * starts from an empty library and bucket and leaves the driver empty.
 */

const ORIGIN = "https://files.stratosonic.test";
// The scan driver is inert unless a test is about what the driver does.
const harness = filesHarness(ORIGIN);
const real = filesHarness(ORIGIN, { scanDriver: "real" });

let owner: CookieJar;
let guest: CookieJar;

beforeAll(async () => {
  // The bootstrap's Subsonic admin, which a pass's playlist import needs.
  await SELF.fetch(`${BASE}/rest/ping`);
  await seedConsoleUser("owner", "files");
  await seedConsoleUser("guest", "nothing", GUEST_ROLE);
  owner = (await signIn(harness.send, ORIGIN, "owner", "files")).jar;
  guest = (await signIn(harness.send, ORIGIN, "guest", "nothing")).jar;
});

beforeEach(async () => {
  await resetLibrary();
  harness.r2Calls.length = 0;
  harness.driverCalls.length = 0;
  real.r2Calls.length = 0;
  real.driverCalls.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  // What a test told the real driver, a pass or a pending change, must not
  // leak into the next test.
  await resetDriver();
});

/** A `FILE_WRITES = "off"` deployment, as preview is. */
function readOnly(): FilesHarness {
  return filesHarness(ORIGIN, { fileWrites: "off" });
}

/** `scan` from the inert driver: a pass at some time. */
const SCHEDULED = {
  scheduledAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
  afterCurrentPass: false,
};

/** `scan` when a pass that began before the change is running: one more follows it. */
const AFTER_CURRENT_PASS = { scheduledAt: null, afterCurrentPass: true };

/** `scan` when a pass that began after the change is running: it covers the change. */
const COVERED_BY_CURRENT_PASS = { scheduledAt: null, afterCurrentPass: false };

/**
 * That the real driver holds the change the route recorded, and nothing
 * else: `pending`, with its debounce alarm at `LibraryChangedAt +
 * RESCAN_QUIET_MS`, and that `scan` says the same instant.
 */
async function expectPendingChange(scan: unknown): Promise<void> {
  const changedAt = await libraryChangedAt();
  if (changedAt === null) {
    throw new Error("the route recorded no change");
  }
  expect(await storedKeys()).toEqual(["pending"]);
  expect(await nextAlarmAt()).toBe(changedAt + RESCAN_QUIET_MS);
  expect(scan).toEqual({
    scheduledAt: new Date(changedAt + RESCAN_QUIET_MS).toISOString(),
    afterCurrentPass: false,
  });
}

/** A request that is not JSON, but otherwise as the console sends it. */
function plainText(path: string): Request {
  return new Request(`${ORIGIN}/api${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, cookie: owner.header(), "content-type": "text/plain" },
    body: "{}",
  });
}

async function libraryChangedAt(): Promise<number | null> {
  const [row] = await database(testEnv)
    .select()
    .from(property)
    .where(eq(property.id, "LibraryChangedAt"));
  return row === undefined ? null : (JSON.parse(row.value) as { at: number }).at;
}

/* ===================================================== GET /files/config == */

describe("GET /api/files/config", () => {
  it("answers the bucket, the uploads, the allow-list, the limits, the quiet window and that writes are on", async () => {
    const response = await harness.call(owner, "GET", "/files/config");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      bucket: "navidrome",
      // The pinned environment leaves the upload token unset
      // (test/files-uploads.test.ts covers a configured one).
      uploads: {
        configured: false,
        missing: ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "CF_ACCOUNT_ID"],
      },
      allowed: {
        audio: { suffixes: ["mp3", "m4a", "flac"], maxBytes: 5_363_466_240 },
        lyrics: { suffixes: ["lrc", "txt"], maxBytes: 1_048_576 },
        playlist: { suffixes: ["m3u", "m3u8"], maxBytes: 4_194_304 },
        image: { suffixes: ["jpg", "png", "gif", "webp", "jpeg"], maxBytes: 20_971_520 },
      },
      limits: { maxKeyBytes: 1024, maxSegmentBytes: 255, signBatch: 10, deleteBatch: 250 },
      rescanQuietSeconds: 120,
      writes: { enabled: true },
    });
    expect(ALLOWED.audio.maxBytes).toBe(5_363_466_240);
    expect([MAX_KEY_BYTES, MAX_SEGMENT_BYTES, DELETE_BATCH]).toEqual([1024, 255, 250]);
    expect(RESCAN_QUIET_MS).toBe(120_000);
    expect(harness.r2Calls).toEqual([]);
    expect(harness.driverCalls).toEqual([]);
  });

  it.each([
    ["off", false],
    ["OFF", false],
    [" off ", false],
    ["Off\n", false],
    [undefined, true],
    ["", true],
    ["on", true],
    ["false", true],
    ["offf", true],
  ])("reports writes enabled: %j gives %s, case and spaces ignored", async (value, enabled) => {
    const response = await filesHarness(ORIGIN, { fileWrites: value }).call(
      owner,
      "GET",
      "/files/config",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ writes: { enabled } });
  });

  it("answers 401 without a session, and 403 to a role without files:read", async () => {
    const anonymous = await harness.call(undefined, "GET", "/files/config");
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "unauthenticated" });

    const forbidden = await harness.call(guest, "GET", "/files/config");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });
  });
});

/* =========================================================== GET /files == */

interface Listing {
  prefix: string;
  folders: { name: string; prefix: string }[];
  files: { name: string; key: string; size: number; uploadedAt: string; kind: string }[];
  cursor: string | null;
}

const BROWSED = [
  "Root.mp3",
  "Artist/Album/",
  "Artist/Album/01 Song.flac",
  "Artist/Album/01 Song.lrc",
  "Artist/Album/CD1/01 Other.mp3",
  "Artist/Album/cover.JPG",
  "Artist/Album/notes.cue",
  "Artist/Album/zz.m3u8",
  "_covers/abc.png",
  "playlists/mix.m3u",
];

async function browse(query: string, on: FilesHarness = harness): Promise<Listing> {
  const response = await on.call(owner, "GET", `/files${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Listing;
}

describe("GET /api/files", () => {
  beforeEach(async () => {
    await seedObjects(BROWSED.filter((key) => !key.endsWith("/")));
    // A zero-byte folder marker, as some S3 tools write.
    await testEnv.MUSIC.put("Artist/Album/", new Uint8Array());
    harness.r2Calls.length = 0;
  });

  it("lists the root's folders and files, without _covers/, in one listing", async () => {
    const listing = await browse("");

    expect(listing).toEqual({
      prefix: "",
      folders: [
        { name: "Artist", prefix: "Artist/" },
        { name: "playlists", prefix: "playlists/" },
      ],
      files: [
        {
          name: "Root.mp3",
          key: "Root.mp3",
          size: "bytes of Root.mp3".length,
          uploadedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
          kind: "audio",
        },
      ],
      cursor: null,
    });
    expect(harness.r2Calls).toEqual([
      { method: "list", argument: { prefix: "", delimiter: "/", limit: 1000, cursor: undefined } },
    ]);
  });

  it("splits a folder into its folders and files, each with its kind, and hides its marker", async () => {
    const listing = await browse("?prefix=Artist%2FAlbum%2F");

    expect(listing.prefix).toBe("Artist/Album/");
    expect(listing.folders).toEqual([{ name: "CD1", prefix: "Artist/Album/CD1/" }]);
    expect(listing.files.map(({ name, key, kind }) => ({ name, key, kind }))).toEqual([
      { name: "01 Song.flac", key: "Artist/Album/01 Song.flac", kind: "audio" },
      { name: "01 Song.lrc", key: "Artist/Album/01 Song.lrc", kind: "lyrics" },
      { name: "cover.JPG", key: "Artist/Album/cover.JPG", kind: "image" },
      { name: "notes.cue", key: "Artist/Album/notes.cue", kind: "other" },
      { name: "zz.m3u8", key: "Artist/Album/zz.m3u8", kind: "playlist" },
    ]);
    const object = await testEnv.MUSIC.head("Artist/Album/01 Song.flac");
    expect(listing.files[0]).toMatchObject({
      size: object?.size,
      uploadedAt: object?.uploaded.toISOString(),
    });
    expect(listing.cursor).toBeNull();
  });

  it("pages with R2's cursor, and the next page carries on", async () => {
    const paged = filesHarness(ORIGIN, { listLimit: 2 });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = `?prefix=Artist%2FAlbum%2F${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const listing: Listing = await browse(query, paged);
      seen.push(...listing.folders.map((folder) => folder.prefix));
      seen.push(...listing.files.map((file) => file.key));
      cursor = listing.cursor;
      pages++;
      if (pages === 1) {
        expect(cursor).not.toBeNull();
      }
    } while (cursor !== null && pages < 10);

    expect(pages).toBeGreaterThan(1);
    const whole = await browse("?prefix=Artist%2FAlbum%2F");
    expect(seen.sort()).toEqual(
      [
        ...whole.folders.map((folder) => folder.prefix),
        ...whole.files.map((file) => file.key),
      ].sort(),
    );
  });

  it("answers 400 invalid_cursor to a cursor R2 refuses, not 500", async () => {
    // Miniflare's R2 takes any string as a cursor; the real one refuses a
    // cursor it never issued, which the harness stands in for.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const forged = filesHarness(ORIGIN, { refusedCursor: "forged" });

    const response = await forged.call(owner, "GET", "/files?prefix=Artist%2F&cursor=forged");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_cursor" });
    expect(forged.r2Calls).toHaveLength(1);
  });

  it("answers 500 to a listing R2 fails without a cursor", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = filesHarness(ORIGIN, { failListing: true });

    const response = await failing.call(owner, "GET", "/files?prefix=Artist%2F");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
  });

  it("answers 403 reserved_path for _covers/, without listing it", async () => {
    for (const prefix of ["_covers%2F", "_covers%2Fsub%2F"]) {
      const response = await harness.call(owner, "GET", `/files?prefix=${prefix}`);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "reserved_path" });
    }
    expect(harness.r2Calls).toEqual([]);
  });

  it("answers 400 invalid_path for a prefix that is not a folder, or is too long", async () => {
    for (const prefix of ["Artist", "Artist%2FAlbum", encodeURIComponent(`${"a".repeat(1024)}/`)]) {
      const response = await harness.call(owner, "GET", `/files?prefix=${prefix}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_path" });
    }
    expect(harness.r2Calls).toEqual([]);
  });

  it("answers 401 without a session, and 403 to a role without files:read", async () => {
    const anonymous = await harness.call(undefined, "GET", "/files");
    expect(anonymous.status).toBe(401);
    const forbidden = await harness.call(guest, "GET", "/files");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });
    expect(harness.r2Calls).toEqual([]);
  });

  it("still browses where FILE_WRITES is off", async () => {
    expect((await browse("", readOnly())).folders).toHaveLength(2);
  });
});

/* ===================================================== POST /files/delete == */

const OWNER_ID = "files-owner";

/** A playlist row, its two entries and its `.m3u`, as an import would leave them. */
async function seedPlaylistFile(r2Key: string): Promise<string> {
  await testEnv.MUSIC.put(r2Key, "#EXTM3U\nArtist/Album/01 Song.flac\n");
  const row = await seedPlaylist({ r2Key, ownerId: OWNER_ID });
  await database(testEnv)
    .insert(playlistTrack)
    .values([
      { playlistId: row.id, trackId: "tr-1", position: 0 },
      { playlistId: row.id, trackId: "tr-2", position: 1 },
    ]);
  return row.id;
}

describe("POST /api/files/delete", () => {
  const KEYS = ["Artist/Album/01 Song.flac", "Artist/Album/01 Song.lrc"];
  const KEPT = ["Artist/Album/02 Next.flac", "Other/01.mp3", "_covers/abc.png"];

  beforeEach(async () => {
    await seedObjects([...KEYS, ...KEPT]);
    harness.r2Calls.length = 0;
  });

  it("deletes the objects, in one binding call, and keeps no copy of them anywhere", async () => {
    const before = await allKeys();
    const response = await harness.call(owner, "POST", "/files/delete", { keys: KEYS });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 2, scan: SCHEDULED });
    expect(await allKeys()).toEqual(before.filter((key) => !KEYS.includes(key)));
    // No trash: nothing was written, copied or moved, only deleted.
    expect(harness.r2Calls).toEqual([{ method: "delete", argument: KEYS }]);
    expect(await allKeys()).toEqual([...KEPT].sort());
  });

  it("counts a key given twice once, and a key that is not there as deleted", async () => {
    const response = await harness.call(owner, "POST", "/files/delete", {
      keys: [KEYS[0], KEYS[0], "Artist/Album/missing.flac"],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ deleted: 2 });
    expect(harness.r2Calls).toEqual([
      { method: "delete", argument: [KEYS[0], "Artist/Album/missing.flac"] },
    ]);
  });

  it("uses the keys exactly as given, never normalised", async () => {
    const nfd = "Björk/01.flac";
    const nfc = nfd.normalize("NFC");
    await seedObjects([nfd]);
    harness.r2Calls.length = 0;

    const response = await harness.call(owner, "POST", "/files/delete", { keys: [nfd] });

    expect(response.status).toBe(200);
    expect(harness.r2Calls).toEqual([{ method: "delete", argument: [nfd] }]);
    expect(nfc).not.toBe(nfd);
  });

  it("takes a deleted playlist's row and entries out at once, before any pass", async () => {
    const id = await seedPlaylistFile("playlists/mix.m3u");
    const kept = await seedPlaylistFile("playlists/kept.m3u8");

    const response = await harness.call(owner, "POST", "/files/delete", {
      keys: ["playlists/mix.m3u", KEYS[0]],
    });

    expect(response.status).toBe(200);
    const db = database(testEnv);
    expect(await db.select().from(playlist).where(eq(playlist.id, id))).toEqual([]);
    expect(await db.select().from(playlistTrack).where(eq(playlistTrack.playlistId, id))).toEqual(
      [],
    );
    expect(await db.select().from(playlist).where(eq(playlist.id, kept))).toHaveLength(1);
    expect(
      await db.select().from(playlistTrack).where(eq(playlistTrack.playlistId, kept)),
    ).toHaveLength(2);
  });

  it("records the change and tells the driver, which then holds the pending pass", async () => {
    const before = Date.now();
    const response = await real.call(owner, "POST", "/files/delete", { keys: KEYS });
    const after = Date.now();

    expect(response.status).toBe(200);
    const changedAt = await libraryChangedAt();
    expect(changedAt).toBeGreaterThanOrEqual(before);
    expect(changedAt).toBeLessThanOrEqual(after);
    expect(real.driverCalls).toEqual(["touch"]);
    // No pass yet: the change waits out the quiet window.
    await expectPendingChange(((await response.json()) as { scan: unknown }).scan);
  });

  it("answers that a pass follows the one running, when it began before the change", async () => {
    await poke(new Date());

    const response = await real.call(owner, "POST", "/files/delete", { keys: KEYS });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 2, scan: AFTER_CURRENT_PASS });
    expect(await storedKeys()).toEqual(["driver", "pending"]);
  });

  it("answers that the pass running covers the change, when it began after it", async () => {
    // A pass stamped a minute ahead began, as the driver sees it, after the
    // change the route makes now.
    await poke(new Date(Date.now() + 60_000));

    const response = await real.call(owner, "POST", "/files/delete", { keys: KEYS });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 2, scan: COVERED_BY_CURRENT_PASS });
  });

  it("replaces an earlier LibraryChangedAt with the change's own instant", async () => {
    await database(testEnv)
      .insert(property)
      .values({ id: "LibraryChangedAt", value: JSON.stringify({ at: 1_000 }) });

    const before = Date.now();
    expect((await harness.call(owner, "POST", "/files/delete", { keys: KEYS })).status).toBe(200);
    expect(await libraryChangedAt()).toBeGreaterThanOrEqual(before);
  });

  it("keeps the later LibraryChangedAt when an earlier one arrives", async () => {
    await database(testEnv)
      .insert(property)
      .values({ id: "LibraryChangedAt", value: JSON.stringify({ at: Date.now() + 3_600_000 }) });
    const later = await libraryChangedAt();

    expect((await harness.call(owner, "POST", "/files/delete", { keys: KEYS })).status).toBe(200);
    expect(await libraryChangedAt()).toBe(later);
  });

  it("still answers 200, with scan: null, when the driver cannot be told", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = filesHarness(ORIGIN, { scanDriver: unreachableDriver() });

    const response = await failing.call(owner, "POST", "/files/delete", { keys: KEYS });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 2, scan: null });
    expect(await allKeys()).toEqual([...KEPT].sort());
    expect(await libraryChangedAt()).not.toBeNull();
    expect(failing.driverCalls).toHaveLength(1);
  });

  it("answers 500 when the change cannot be recorded in D1, with the files gone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = filesHarness(ORIGIN, { failPropertyWrite: true });

    const response = await failing.call(owner, "POST", "/files/delete", { keys: KEYS });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expect(await allKeys()).toEqual([...KEPT].sort());
    expect(failing.driverCalls).toEqual([]);
  });

  it("takes 250 keys of 1,024 bytes, a body far over the 16 KiB cap", async () => {
    const keys = Array.from(
      { length: DELETE_BATCH },
      (_, index) => `Long/${String(index).padStart(4, "0")}${"x".repeat(MAX_KEY_BYTES - 9)}`,
    );
    expect(new TextEncoder().encode(keys[0]).length).toBe(MAX_KEY_BYTES);
    expect(JSON.stringify({ keys }).length).toBeGreaterThan(MAX_JSON_BODY_BYTES);

    const response = await harness.call(owner, "POST", "/files/delete", { keys });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ deleted: DELETE_BATCH });
  });

  it("refuses the whole request, touching nothing, when any key is under _covers/", async () => {
    await expectRefusal(
      harness,
      () => harness.call(owner, "POST", "/files/delete", { keys: [KEYS[0], "_covers/abc.png"] }),
      403,
      "reserved_path",
    );
  });

  it.each([
    ["251 keys", { keys: Array.from({ length: 251 }, (_, index) => `k/${index}.flac`) }],
    ["no key", { keys: [] }],
    ["no keys field", {}],
    ["keys that are not a list", { keys: "Artist/Album/01 Song.flac" }],
    ["a key that is not a string", { keys: [KEYS[0], 7] }],
    ["an empty key", { keys: [""] }],
    ["a key over 1,024 bytes", { keys: [`${"一".repeat(342)}.flac`] }],
    ["a body that is not an object", [KEYS[0]]],
  ])("answers 400 invalid_request to %s, touching nothing", async (_, body) => {
    await expectRefusal(
      harness,
      () => harness.call(owner, "POST", "/files/delete", body),
      400,
      "invalid_request",
    );
  });

  it("answers 401 without a session", async () => {
    await expectRefusal(
      harness,
      () => harness.call(undefined, "POST", "/files/delete", { keys: KEYS }),
      401,
      "unauthenticated",
    );
  });

  it("answers 403 forbidden to a role without files:write", async () => {
    await expectRefusal(
      harness,
      () => harness.call(guest, "POST", "/files/delete", { keys: KEYS }),
      403,
      "forbidden",
    );
  });

  it("answers 403 forbidden_origin cross-origin, and to a body that is not JSON", async () => {
    await expectRefusal(
      harness,
      () =>
        harness.call(
          owner,
          "POST",
          "/files/delete",
          { keys: KEYS },
          { origin: "https://evil.test" },
        ),
      403,
      "forbidden_origin",
    );
    await expectRefusal(
      harness,
      () => harness.send(plainText("/files/delete")),
      403,
      "forbidden_origin",
    );
  });

  it("answers 413 to a body over 512 KiB", async () => {
    await expectRefusal(
      harness,
      () =>
        harness.call(owner, "POST", "/files/delete", {
          keys: KEYS,
          padding: "x".repeat(MAX_FILE_DELETE_BODY_BYTES),
        }),
      413,
      "payload_too_large",
    );
  });

  it.each(["off", "OFF", " off "])(
    "answers 403 file_writes_disabled where FILE_WRITES is %j, changing nothing",
    async (value) => {
      const preview = filesHarness(ORIGIN, { fileWrites: value });
      await expectRefusal(
        preview,
        () => preview.call(owner, "POST", "/files/delete", { keys: KEYS }),
        403,
        "file_writes_disabled",
      );
    },
  );

  it("works where FILE_WRITES is not set at all", async () => {
    const response = await filesHarness(ORIGIN, { fileWrites: undefined }).call(
      owner,
      "POST",
      "/files/delete",
      { keys: KEYS },
    );

    expect(response.status).toBe(200);
  });
});

/* ============================================== POST /files/delete-folder == */

describe("POST /api/files/delete-folder", () => {
  const OUTSIDE = [
    "Big/Folder2/a.flac",
    "Big/Folder.flac",
    "Big/other.mp3",
    "_covers/abc.png",
    "Small/x.mp3",
  ];

  it("deletes 250 keys in two rounds of 2 pages of 100, every depth, and nothing outside the prefix", {
    timeout: 30_000,
  }, async () => {
    // The production shape, 2,500 keys in rounds of 2 listings of 1,000,
    // scaled down tenfold with an injected page, and a driver that starts
    // no pass in the background.
    const scaled = filesHarness(ORIGIN, { listLimit: 100, scanDriver: inertDriver() });
    const inside = Array.from({ length: 250 }, (_, index) =>
      index % 5 === 0
        ? `Big/Folder/CD${index % 3}/${String(index).padStart(4, "0")}.lrc`
        : `Big/Folder/${String(index).padStart(4, "0")}.txt`,
    );
    await seedObjects([...inside, ...OUTSIDE], 50);

    const first = await scaled.call(owner, "POST", "/files/delete-folder", {
      prefix: "Big/Folder/",
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ deleted: 200, done: false, scan: SCHEDULED });
    expect(scaled.r2Calls.map((call) => call.method)).toEqual(["list", "delete", "list", "delete"]);
    // The route asks for R2's own page; the harness gives it 100.
    expect(scaled.r2Calls[0]?.argument).toEqual({ prefix: "Big/Folder/", limit: 1000 });

    const second = await scaled.call(owner, "POST", "/files/delete-folder", {
      prefix: "Big/Folder/",
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ deleted: 50, done: true, scan: SCHEDULED });

    expect(await allKeys("Big/Folder/")).toEqual([]);
    expect(await allKeys()).toEqual([...OUTSIDE].sort());

    // A folder already gone: nothing deleted, nothing recorded, no `scan`.
    scaled.d1.reset();
    const driverCalls = scaled.driverCalls.length;
    const third = await scaled.call(owner, "POST", "/files/delete-folder", {
      prefix: "Big/Folder/",
    });
    expect(await third.json()).toEqual({ deleted: 0, done: true });
    expect(scaled.driverCalls).toHaveLength(driverCalls);
    expect(scaled.d1.statements.some((statement) => /"property"/.test(statement.sql))).toBe(false);
  });

  it("answers done once a listing comes back complete, with smaller pages", async () => {
    const paged = filesHarness(ORIGIN, { listLimit: 2 });
    await seedObjects([
      "Small/a.mp3",
      "Small/b.mp3",
      "Small/c/d.mp3",
      "Small/e.lrc",
      "Small/f.txt",
      "Smaller.mp3",
    ]);

    const rounds: unknown[] = [];
    for (let round = 0; round < 5; round++) {
      const response = await paged.call(owner, "POST", "/files/delete-folder", {
        prefix: "Small/",
      });
      const body = (await response.json()) as { deleted: number; done: boolean };
      rounds.push({ deleted: body.deleted, done: body.done });
      if (body.done) {
        break;
      }
    }

    expect(rounds).toEqual([
      { deleted: 4, done: false },
      { deleted: 1, done: true },
    ]);
    expect(await allKeys()).toEqual(["Smaller.mp3"]);
  });

  it("takes the folder's playlists' rows out at once, and records the change", async () => {
    const id = await seedPlaylistFile("Mixes/road.m3u");
    await seedObjects(["Mixes/road.lrc"]);

    const response = await real.call(owner, "POST", "/files/delete-folder", {
      prefix: "Mixes/",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { deleted: number; done: boolean; scan: unknown };
    expect(body).toMatchObject({ deleted: 2, done: true });
    expect(await database(testEnv).select().from(playlist).where(eq(playlist.id, id))).toEqual([]);
    expect(real.driverCalls).toEqual(["touch"]);
    await expectPendingChange(body.scan);
  });

  it("answers that a pass follows the one running, when it began before the change", async () => {
    await seedObjects(["Mixes/a.lrc"]);
    await poke(new Date());

    const response = await real.call(owner, "POST", "/files/delete-folder", {
      prefix: "Mixes/",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 1, done: true, scan: AFTER_CURRENT_PASS });
  });

  it("answers that the pass running covers the change, when it began after it", async () => {
    await seedObjects(["Mixes/a.lrc"]);
    await poke(new Date(Date.now() + 60_000));

    const response = await real.call(owner, "POST", "/files/delete-folder", {
      prefix: "Mixes/",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deleted: 1,
      done: true,
      scan: COVERED_BY_CURRENT_PASS,
    });
  });

  it("accounts for the first page when the second delete fails, then answers 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = filesHarness(ORIGIN, {
      listLimit: 2,
      failDeleteCall: 2,
      scanDriver: inertDriver(),
    });
    // Sorts first, so the first page reaches it.
    const id = await seedPlaylistFile("Half/0-mix.m3u");
    await seedObjects(["Half/a.txt", "Half/b.txt", "Half/c.txt"]);

    const response = await failing.call(owner, "POST", "/files/delete-folder", {
      prefix: "Half/",
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    // The first page is gone, and what follows a delete was done for it.
    expect(await allKeys("Half/")).toEqual(["Half/b.txt", "Half/c.txt"]);
    expect(await database(testEnv).select().from(playlist).where(eq(playlist.id, id))).toEqual([]);
    expect(await libraryChangedAt()).not.toBeNull();
    expect(failing.driverCalls).toHaveLength(1);
  });

  it("answers 500, recording nothing, when the first delete fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = filesHarness(ORIGIN, { failDeleteCall: 1, scanDriver: inertDriver() });
    await seedObjects(["Half/a.txt"]);

    const response = await failing.call(owner, "POST", "/files/delete-folder", {
      prefix: "Half/",
    });

    expect(response.status).toBe(500);
    expect(await allKeys("Half/")).toEqual(["Half/a.txt"]);
    expect(await libraryChangedAt()).toBeNull();
    expect(failing.driverCalls).toEqual([]);
  });

  it("still answers 200, with scan: null, when the driver cannot be told", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = filesHarness(ORIGIN, { scanDriver: unreachableDriver() });
    await seedObjects(["Gone/a.mp3"]);

    const response = await failing.call(owner, "POST", "/files/delete-folder", { prefix: "Gone/" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 1, done: true, scan: null });
  });

  it.each([
    ["the root", ""],
    ["a prefix that is not a folder", "Big/Folder"],
    ["a prefix over 1,024 bytes", `${"a".repeat(1024)}/`],
  ])("answers 400 invalid_path to %s, touching nothing", async (_, prefix) => {
    await seedObjects(["Big/Folder/a.flac", ...OUTSIDE]);
    await expectRefusal(
      harness,
      () => harness.call(owner, "POST", "/files/delete-folder", { prefix }),
      400,
      "invalid_path",
    );
  });

  it("answers 403 reserved_path to _covers/, touching nothing", async () => {
    await seedObjects(OUTSIDE);
    for (const prefix of ["_covers/", "_covers/sub/"]) {
      await expectRefusal(
        harness,
        () => harness.call(owner, "POST", "/files/delete-folder", { prefix }),
        403,
        "reserved_path",
      );
    }
  });

  it.each([
    ["no prefix", {}],
    ["a prefix that is not a string", { prefix: 3 }],
    ["a body that is not an object", "Big/"],
  ])("answers 400 invalid_request to %s", async (_, body) => {
    await expectRefusal(
      harness,
      () => harness.call(owner, "POST", "/files/delete-folder", body),
      400,
      "invalid_request",
    );
  });

  it("answers 401 without a session, and 403 forbidden to a role without files:write", async () => {
    await seedObjects(OUTSIDE);
    await expectRefusal(
      harness,
      () => harness.call(undefined, "POST", "/files/delete-folder", { prefix: "Big/" }),
      401,
      "unauthenticated",
    );
    await expectRefusal(
      harness,
      () => harness.call(guest, "POST", "/files/delete-folder", { prefix: "Big/" }),
      403,
      "forbidden",
    );
  });

  it("answers 403 forbidden_origin cross-origin, and to a body that is not JSON", async () => {
    await seedObjects(OUTSIDE);
    await expectRefusal(
      harness,
      () =>
        harness.call(
          owner,
          "POST",
          "/files/delete-folder",
          { prefix: "Big/" },
          { origin: "https://evil.test" },
        ),
      403,
      "forbidden_origin",
    );
    await expectRefusal(
      harness,
      () => harness.send(plainText("/files/delete-folder")),
      403,
      "forbidden_origin",
    );
  });

  it("answers 413 to a body over 16 KiB", async () => {
    await seedObjects(OUTSIDE);
    await expectRefusal(
      harness,
      () =>
        harness.call(owner, "POST", "/files/delete-folder", {
          prefix: "Big/",
          padding: "x".repeat(MAX_JSON_BODY_BYTES),
        }),
      413,
      "payload_too_large",
    );
  });

  it("answers 403 file_writes_disabled where FILE_WRITES is off, changing nothing", async () => {
    await seedObjects(["Big/Folder/a.flac", ...OUTSIDE]);
    await seedPlaylistFile("Big/Folder/mix.m3u");
    const preview = readOnly();
    await expectRefusal(
      preview,
      () => preview.call(owner, "POST", "/files/delete-folder", { prefix: "Big/Folder/" }),
      403,
      "file_writes_disabled",
    );
  });
});

/* ======================================================== preview switch == */

describe("with FILE_WRITES unset", () => {
  it("both delete routes work, and the config reports writes as enabled", async () => {
    await seedObjects(["A/1.mp3", "B/2.mp3"]);
    const unset = filesHarness(ORIGIN);

    expect(await (await unset.call(owner, "GET", "/files/config")).json()).toMatchObject({
      writes: { enabled: true },
    });
    expect((await unset.call(owner, "POST", "/files/delete", { keys: ["A/1.mp3"] })).status).toBe(
      200,
    );
    expect((await unset.call(owner, "POST", "/files/delete-folder", { prefix: "B/" })).status).toBe(
      200,
    );
    expect(await allKeys()).toEqual([]);
    expect((await rows()).playlists).toEqual([]);
  });
});
