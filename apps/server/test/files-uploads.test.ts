import { SELF } from "cloudflare:test";
import { property } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEADS_IN_FLIGHT, SIGN_BATCH } from "../src/api/files";
import { MAX_JSON_BODY_BYTES } from "../src/api/json-body";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { forgetUploadsWarning } from "../src/files/config";
import { ALLOWED } from "../src/files/keys";
import { type CookieJar, GUEST_ROLE, seedConsoleUser, signIn } from "./console-auth-support";
import { driverIsIdle, driveUntilIdle } from "./driver-support";
import {
  allKeys,
  expectRefusal,
  type FilesHarness,
  filesHarness,
  seedObjects,
  UPLOADS_ENV,
  unreachableDriver,
} from "./files-support";
import { resetLibrary } from "./scan-support";
import { canonicalObjectPath } from "./sigv4-oracle";
import { BASE, testEnv } from "./support";

/**
 * The upload routes (#83, "API: uploads"; #132): `POST /api/files/uploads`,
 * which presigns each file's `PUT`, and `POST /api/files/uploads/complete`,
 * which records the change once R2 has taken the files, through the Worker's
 * app over the pool's D1, R2 and scan driver, each recorded by the harness
 * (test/files-support.ts). The signatures themselves are checked against an
 * independent SigV4 in test/files-sign.test.ts; miniflare has no S3 endpoint,
 * so no URL is sent anywhere.
 *
 * Every credential here is made up (`UPLOADS_ENV`).
 */

const ORIGIN = "https://uploads.stratosonic.test";
const harness = filesHarness(ORIGIN, { uploads: UPLOADS_ENV });
const ENDPOINT = `https://${UPLOADS_ENV.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`;

let owner: CookieJar;
let guest: CookieJar;

beforeAll(async () => {
  // The bootstrap's Subsonic admin, which a pass's playlist import needs.
  await SELF.fetch(`${BASE}/rest/ping`);
  await seedConsoleUser("owner", "uploads");
  await seedConsoleUser("guest", "nothing", GUEST_ROLE);
  owner = (await signIn(harness.send, ORIGIN, "owner", "uploads")).jar;
  guest = (await signIn(harness.send, ORIGIN, "guest", "nothing")).jar;
});

beforeEach(async () => {
  await resetLibrary();
  harness.r2Calls.length = 0;
  harness.r2Peak.peak = 0;
  harness.driverCalls.length = 0;
  forgetUploadsWarning();
});

afterEach(async () => {
  vi.restoreAllMocks();
  // A completion pokes the driver; its pass must not leak into the next test.
  await driveUntilIdle();
});

/** A request that is not JSON, but otherwise as the console sends it. */
function plainText(path: string): Request {
  return new Request(`${ORIGIN}/api${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, cookie: owner.header(), "content-type": "text/plain" },
    body: "{}",
  });
}

/** A `FILE_WRITES = "off"` deployment, as preview is, with uploads configured. */
function readOnly(): FilesHarness {
  return filesHarness(ORIGIN, { fileWrites: "off", uploads: UPLOADS_ENV });
}

/**
 * Whether `scan` is one of the driver's answers (`ScanSchedule`): a pass at
 * a time; one more after the pass running; or none needed, the running pass
 * covering the change. `null` (the driver unreachable) is not one.
 */
function isScanSchedule(scan: unknown): boolean {
  if (typeof scan !== "object" || scan === null) {
    return false;
  }
  const { scheduledAt, afterCurrentPass, ...rest } = scan as Record<string, unknown>;
  if (Object.keys(rest).length > 0) {
    return false;
  }
  if (typeof scheduledAt === "string") {
    return afterCurrentPass === false && !Number.isNaN(Date.parse(scheduledAt));
  }
  return scheduledAt === null && typeof afterCurrentPass === "boolean";
}

async function libraryChangedAt(): Promise<number | null> {
  const [row] = await database(testEnv)
    .select()
    .from(property)
    .where(eq(property.id, "LibraryChangedAt"));
  return row === undefined ? null : (JSON.parse(row.value) as { at: number }).at;
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

type Result = Signed | Refused;

async function sign(
  files: unknown[],
  on: FilesHarness = harness,
): Promise<{ status: number; uploads: Result[] }> {
  const response = await on.call(owner, "POST", "/files/uploads", { files });
  const body = (await response.json()) as { uploads: Result[] };
  return { status: response.status, uploads: body.uploads };
}

function signed(result: Result | undefined): Signed {
  expect(result).toHaveProperty("url");
  return result as Signed;
}

/** Each logged argument, so a test can look for a secret in it. */
function captureLogs(): unknown[][] {
  const logged: unknown[][] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  }
  return logged;
}

/* ===================================================== GET /files/config == */

describe("GET /api/files/config, uploads", () => {
  it("names the bucket, says uploads are configured, and caps a sign batch at 10", async () => {
    const response = await harness.call(owner, "GET", "/files/config");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      bucket: "navidrome",
      uploads: { configured: true },
      limits: { maxKeyBytes: 1024, maxSegmentBytes: 255, signBatch: 10, deleteBatch: 250 },
    });
    expect(SIGN_BATCH).toBe(10);
    expect(harness.r2Calls).toEqual([]);
  });

  it("names the values that are missing, and never a value", async () => {
    const logged = captureLogs();
    const unset = filesHarness(ORIGIN);

    const response = await unset.call(owner, "GET", "/files/config");
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({
      bucket: "navidrome",
      uploads: {
        configured: false,
        missing: ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "CF_ACCOUNT_ID"],
      },
    });
    // Nothing tried to configure uploads, so nothing is worth a warning.
    expect(logged).toEqual([]);

    const noBucket = filesHarness(ORIGIN, { uploads: { ...UPLOADS_ENV, R2_BUCKET_NAME: " " } });
    const withoutBucket = await (await noBucket.call(owner, "GET", "/files/config")).text();
    expect(JSON.parse(withoutBucket)).toMatchObject({
      bucket: null,
      uploads: { configured: false, missing: ["R2_BUCKET_NAME"] },
    });
    expect(withoutBucket).not.toContain(UPLOADS_ENV.R2_SECRET_ACCESS_KEY);
    expect(withoutBucket).not.toContain(UPLOADS_ENV.R2_ACCESS_KEY_ID);
  });

  it("warns once per isolate when the token is set but not everything else", async () => {
    const logged = captureLogs();
    const partial = filesHarness(ORIGIN, {
      uploads: { R2_ACCESS_KEY_ID: UPLOADS_ENV.R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY: "" },
    });

    for (let round = 0; round < 3; round++) {
      const response = await partial.call(owner, "GET", "/files/config");
      expect(await response.json()).toMatchObject({
        uploads: { configured: false, missing: ["R2_SECRET_ACCESS_KEY", "CF_ACCOUNT_ID"] },
      });
    }

    expect(logged).toEqual([
      ["files: uploads stay off until R2_SECRET_ACCESS_KEY, CF_ACCOUNT_ID is set as well"],
    ]);
    expect(JSON.stringify(logged)).not.toContain(UPLOADS_ENV.R2_ACCESS_KEY_ID);
  });
});

/* ======================================================= POST /uploads == */

describe("POST /api/files/uploads", () => {
  it("presigns a PUT for each new file, with If-None-Match: *, in one head() each", async () => {
    const before = Date.now();
    const { status, uploads } = await sign([
      { key: "Artist/Album/01 Title.flac", size: 41_234_567 },
      { key: "Artist/Album/01 Title.lrc", size: 2_048, overwrite: false },
    ]);

    expect(status).toBe(200);
    expect(uploads).toEqual([
      {
        key: "Artist/Album/01 Title.flac",
        url: expect.stringMatching(
          /^https:\/\/0123456789abcdef0123456789abcdef\.r2\.cloudflarestorage\.com\/navidrome\/Artist\/Album\/01%20Title\.flac\?.*X-Amz-Algorithm=AWS4-HMAC-SHA256/,
        ),
        method: "PUT",
        headers: { "Content-Type": "audio/flac", "If-None-Match": "*" },
        expiresAt: expect.any(String),
      },
      {
        key: "Artist/Album/01 Title.lrc",
        url: expect.stringContaining(`${ENDPOINT}/navidrome/Artist/Album/01%20Title.lrc?`),
        method: "PUT",
        headers: { "Content-Type": "text/plain", "If-None-Match": "*" },
        expiresAt: expect.any(String),
      },
    ]);
    for (const upload of uploads) {
      const query = new URL(signed(upload).url).searchParams;
      expect(query.get("X-Amz-Expires")).toBe("300");
      expect(query.get("X-Amz-SignedHeaders")).toBe(
        "content-length;content-type;host;if-none-match",
      );
      const expiresAt = Date.parse(signed(upload).expiresAt);
      expect(expiresAt).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 + 300_000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 300_000);
    }
    expect(harness.r2Calls).toEqual([
      { method: "head", argument: "Artist/Album/01 Title.flac" },
      { method: "head", argument: "Artist/Album/01 Title.lrc" },
    ]);
    // Nothing has changed until a PUT succeeds.
    expect(harness.driverCalls).toEqual([]);
    expect(await libraryChangedAt()).toBeNull();
    expect(await driverIsIdle()).toBe(true);
  });

  it("answers exists, with the stored size and time, for a key already in the bucket", async () => {
    await testEnv.MUSIC.put("Artist/Album/cover.jpg", new Uint8Array(183_422));
    const stored = await testEnv.MUSIC.head("Artist/Album/cover.jpg");

    const { uploads } = await sign([
      { key: "Artist/Album/cover.jpg", size: 99 },
      { key: "Artist/Album/back.jpg", size: 99 },
    ]);

    expect(uploads[0]).toEqual({
      key: "Artist/Album/cover.jpg",
      error: "exists",
      existing: { size: 183_422, uploadedAt: stored?.uploaded.toISOString() },
    });
    expect(signed(uploads[1]).key).toBe("Artist/Album/back.jpg");
  });

  it("signs a Replace without If-None-Match, and a Replace of nothing with it", async () => {
    await seedObjects(["Artist/Album/01 Title.flac"]);

    const { uploads } = await sign([
      { key: "Artist/Album/01 Title.flac", size: 10, overwrite: true },
      { key: "Artist/Album/02 New.flac", size: 10, overwrite: true },
    ]);

    const replaced = signed(uploads[0]);
    expect(replaced.headers).toEqual({ "Content-Type": "audio/flac" });
    expect(new URL(replaced.url).searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-type;host",
    );
    const created = signed(uploads[1]);
    expect(created.headers).toEqual({ "Content-Type": "audio/flac", "If-None-Match": "*" });
  });

  it("replaces a key stored in NFD under its stored spelling when asked in NFC", async () => {
    const nfd = "Björk/Homogenic/01 Hunter.flac";
    const nfc = nfd.normalize("NFC");
    expect(nfc).not.toBe(nfd);
    await seedObjects([nfd]);

    const { uploads } = await sign([{ key: nfc, size: 10, overwrite: true }]);

    const replaced = signed(uploads[0]);
    expect(replaced.key).toBe(nfd);
    expect(new URL(replaced.url).pathname).toBe(canonicalObjectPath("navidrome", nfd));
    expect(replaced.headers).toEqual({ "Content-Type": "audio/flac" });

    // Without overwrite, it exists, by the spelling asked for.
    const { uploads: again } = await sign([{ key: nfc, size: 10 }]);
    expect(again[0]).toMatchObject({ key: nfc, error: "exists" });
  });

  it("signs a new key in NFC, whatever spelling it was asked in", async () => {
    const nfd = "Sigur Rós/()/01.flac";

    const { uploads } = await sign([{ key: nfd, size: 10 }]);

    const created = signed(uploads[0]);
    expect(created.key).toBe(nfd.normalize("NFC"));
    expect(new URL(created.url).pathname).toBe(
      canonicalObjectPath("navidrome", nfd.normalize("NFC")),
    );
    expect(harness.r2Calls).toEqual([{ method: "head", argument: nfd.normalize("NFC") }]);
  });

  it("answers each per-file error, without failing the others, and heads only what passed", async () => {
    await seedObjects(["Taken/01.mp3"]);

    const { status, uploads } = await sign([
      { key: "../escape.flac", size: 10 },
      { key: `${"a".repeat(256)}.flac`, size: 10 },
      { key: "_covers/abc.png", size: 10 },
      { key: "Artist/notes.pdf", size: 10 },
      { key: "Artist/huge.jpg", size: ALLOWED.image.maxBytes + 1 },
      { key: "Artist/empty.lrc", size: 0 },
      { key: "Taken/01.mp3", size: 10 },
      { key: "Fine/01.mp3", size: 10 },
      { key: "/absolute.flac", size: 10 },
      { key: "Folder/", size: 10 },
      { key: "a//b.flac", size: 10 },
      { key: "./a.flac", size: 10 },
      { key: ".hidden/a.flac", size: 10 },
      { key: "Win\\dows.flac", size: 10 },
      { key: "Tab\there.flac", size: 10 },
      { key: "", size: 10 },
      { key: `${"一".repeat(341)}/x.flac`, size: 10 },
      { key: "Fine/02.FLAC", size: ALLOWED.audio.maxBytes },
    ]);

    expect(status).toBe(200);
    expect(uploads.map((upload) => ("error" in upload ? upload.error : "signed"))).toEqual([
      "invalid_path",
      "path_too_long",
      "reserved_path",
      "type_not_allowed",
      "too_large",
      "empty_file",
      "exists",
      "signed",
      "invalid_path",
      "invalid_path",
      "invalid_path",
      "invalid_path",
      "invalid_path",
      "invalid_path",
      "invalid_path",
      "invalid_path",
      "path_too_long",
      "signed",
    ]);
    expect(uploads[3]).toEqual({ key: "Artist/notes.pdf", error: "type_not_allowed" });
    expect(harness.r2Calls).toEqual([
      { method: "head", argument: "Taken/01.mp3" },
      { method: "head", argument: "Fine/01.mp3" },
      { method: "head", argument: "Fine/02.FLAC" },
    ]);
  });

  it.each([
    ["Artist/a.flac", "audio/flac"],
    ["Artist/a.mp3", "audio/mpeg"],
    ["Artist/a.m4a", "audio/mp4"],
    ["Artist/a.lrc", "text/plain"],
    ["Artist/a.txt", "text/plain"],
    ["playlists/a.m3u", "audio/x-mpegurl"],
    ["playlists/a.m3u8", "application/vnd.apple.mpegurl"],
    ["Artist/cover.jpg", "image/jpeg"],
    ["Artist/cover.JPEG", "image/jpeg"],
    ["Artist/cover.png", "image/png"],
    ["Artist/cover.gif", "image/gif"],
    ["Artist/cover.webp", "image/webp"],
  ])("signs %s as %s", async (key, contentType) => {
    const { uploads } = await sign([{ key, size: 10 }]);

    expect(signed(uploads[0]).headers["Content-Type"]).toBe(contentType);
  });

  it("signs 10 files with at most six head() calls in flight", async () => {
    const files = Array.from({ length: SIGN_BATCH }, (_, index) => ({
      key: `Batch/${String(index).padStart(2, "0")}.flac`,
      size: 1_000 + index,
    }));

    const { status, uploads } = await sign(files);

    expect(status).toBe(200);
    expect(uploads.map((upload) => upload.key)).toEqual(files.map((file) => file.key));
    expect(uploads.every((upload) => "url" in upload)).toBe(true);
    expect(harness.r2Calls).toHaveLength(SIGN_BATCH);
    expect(HEADS_IN_FLIGHT).toBe(6);
    expect(harness.r2Peak.peak).toBe(HEADS_IN_FLIGHT);
    // One instant for the batch.
    expect(new Set(uploads.map((upload) => signed(upload).expiresAt)).size).toBe(1);
  });

  it("never puts the secret in an answer or a log line", async () => {
    const logged = captureLogs();
    await seedObjects(["Taken/01.mp3"]);

    const response = await harness.call(owner, "POST", "/files/uploads", {
      files: [
        { key: "New/01.mp3", size: 10 },
        { key: "Taken/01.mp3", size: 10 },
        { key: "Taken/01.mp3", size: 10, overwrite: true },
        { key: "x.pdf", size: 10 },
      ],
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    for (const form of [
      UPLOADS_ENV.R2_SECRET_ACCESS_KEY,
      encodeURIComponent(UPLOADS_ENV.R2_SECRET_ACCESS_KEY),
    ]) {
      expect(text).not.toContain(form);
      expect(JSON.stringify(logged)).not.toContain(form);
    }
    // The Access Key ID is in each URL's credential, as SigV4 requires.
    expect(text).toContain(`${UPLOADS_ENV.R2_ACCESS_KEY_ID}%2F`);
  });

  it("answers 503 uploads_not_configured without every value, touching nothing", async () => {
    for (const uploads of [
      {},
      { ...UPLOADS_ENV, R2_SECRET_ACCESS_KEY: "" },
      { ...UPLOADS_ENV, CF_ACCOUNT_ID: "" },
      { ...UPLOADS_ENV, R2_BUCKET_NAME: "" },
    ]) {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const unconfigured = filesHarness(ORIGIN, { uploads });
      await expectRefusal(
        unconfigured,
        () =>
          unconfigured.call(owner, "POST", "/files/uploads", {
            files: [{ key: "A/b.flac", size: 10 }],
          }),
        503,
        "uploads_not_configured",
      );
      expect(unconfigured.r2Calls).toEqual([]);
    }
  });

  it.each([
    [
      "11 files",
      { files: Array.from({ length: 11 }, (_, i) => ({ key: `k/${i}.flac`, size: 1 })) },
    ],
    ["no file", { files: [] }],
    ["no files field", {}],
    ["files that are not a list", { files: { key: "a.flac", size: 1 } }],
    ["a file that is not an object", { files: ["a.flac"] }],
    ["a key that is not a string", { files: [{ key: 7, size: 1 }] }],
    ["no size", { files: [{ key: "a.flac" }] }],
    ["a size that is not a whole number", { files: [{ key: "a.flac", size: 1.5 }] }],
    ["a negative size", { files: [{ key: "a.flac", size: -1 }] }],
    ["a size that is a string", { files: [{ key: "a.flac", size: "10" }] }],
    ["an overwrite that is not a boolean", { files: [{ key: "a.flac", size: 1, overwrite: 1 }] }],
    ["a body that is not an object", [{ key: "a.flac", size: 1 }]],
  ])("answers 400 invalid_request to %s, touching nothing", async (_, body) => {
    await expectRefusal(
      harness,
      () => harness.call(owner, "POST", "/files/uploads", body),
      400,
      "invalid_request",
    );
    expect(harness.r2Calls).toEqual([]);
  });

  it("answers 401 without a session, and 403 forbidden to a role without files:write", async () => {
    const body = { files: [{ key: "A/b.flac", size: 10 }] };
    await expectRefusal(
      harness,
      () => harness.call(undefined, "POST", "/files/uploads", body),
      401,
      "unauthenticated",
    );
    await expectRefusal(
      harness,
      () => harness.call(guest, "POST", "/files/uploads", body),
      403,
      "forbidden",
    );
    expect(harness.r2Calls).toEqual([]);
  });

  it("answers 403 forbidden_origin cross-origin, and to a body that is not JSON", async () => {
    await expectRefusal(
      harness,
      () =>
        harness.call(
          owner,
          "POST",
          "/files/uploads",
          { files: [{ key: "A/b.flac", size: 10 }] },
          { origin: "https://evil.test" },
        ),
      403,
      "forbidden_origin",
    );
    await expectRefusal(
      harness,
      () => harness.send(plainText("/files/uploads")),
      403,
      "forbidden_origin",
    );
  });

  it("answers 413 to a body over 16 KiB", async () => {
    await expectRefusal(
      harness,
      () =>
        harness.call(owner, "POST", "/files/uploads", {
          files: [{ key: "A/b.flac", size: 10 }],
          padding: "x".repeat(MAX_JSON_BODY_BYTES),
        }),
      413,
      "payload_too_large",
    );
  });

  it("answers 403 file_writes_disabled where FILE_WRITES is off, signing nothing", async () => {
    const preview = readOnly();
    await expectRefusal(
      preview,
      () =>
        preview.call(owner, "POST", "/files/uploads", { files: [{ key: "A/b.flac", size: 10 }] }),
      403,
      "file_writes_disabled",
    );
    expect(preview.r2Calls).toEqual([]);

    // Also where uploads are not configured: the switch answers first.
    const previewUnconfigured = filesHarness(ORIGIN, { fileWrites: "off" });
    await expectRefusal(
      previewUnconfigured,
      () =>
        previewUnconfigured.call(owner, "POST", "/files/uploads", {
          files: [{ key: "A/b.flac", size: 10 }],
        }),
      403,
      "file_writes_disabled",
    );
  });
});

/* ============================================== POST /uploads/complete == */

describe("POST /api/files/uploads/complete", () => {
  it("records the change and tells the driver, with no R2 call", async () => {
    const before = Date.now();
    const response = await harness.call(owner, "POST", "/files/uploads/complete", {
      keys: ["Artist/Album/01 Title.flac", "Artist/Album/01 Title.lrc"],
    });
    const after = Date.now();

    expect(response.status).toBe(200);
    const changedAt = await libraryChangedAt();
    expect(changedAt).toBeGreaterThanOrEqual(before);
    expect(changedAt).toBeLessThanOrEqual(after);
    // The driver's schedule, as the delete routes answer it: with no pass
    // running, a pass at a time.
    const { scan } = (await response.json()) as { scan: { scheduledAt: unknown } };
    expect(isScanSchedule(scan)).toBe(true);
    expect(scan.scheduledAt).toEqual(expect.any(String));
    expect(harness.r2Calls).toEqual([]);
    expect(harness.driverCalls).toHaveLength(1);
    expect(await driverIsIdle()).toBe(false);
  });

  it("answers the driver's schedule as it is, during a pass too", async () => {
    // A driver with a pass running: `start` (the stand-in until #130 merges)
    // and `touch` (#130) both say so.
    const busy = {
      idFromName: (name: string) => testEnv.SCAN_DRIVER.idFromName(name),
      get: () =>
        new Proxy(
          {},
          {
            get: (_, method) => async () =>
              method === "start" ? "running" : { scheduledAt: null, afterCurrentPass: true },
          },
        ),
    } as unknown as Env["SCAN_DRIVER"];
    const during = filesHarness(ORIGIN, { scanDriver: busy, uploads: UPLOADS_ENV });

    const response = await during.call(owner, "POST", "/files/uploads/complete", {
      keys: ["A/b.flac"],
    });

    expect(response.status).toBe(200);
    const { scan } = (await response.json()) as { scan: unknown };
    expect(isScanSchedule(scan)).toBe(true);
    expect(scan).toEqual({ scheduledAt: null, afterCurrentPass: true });
  });

  it("knows every shape of the driver's schedule", () => {
    expect(
      isScanSchedule({ scheduledAt: "2026-10-02T12:00:00.000Z", afterCurrentPass: false }),
    ).toBe(true);
    expect(isScanSchedule({ scheduledAt: null, afterCurrentPass: true })).toBe(true);
    // #137: the running pass already covers the change.
    expect(isScanSchedule({ scheduledAt: null, afterCurrentPass: false })).toBe(true);
    expect(isScanSchedule(null)).toBe(false);
    expect(isScanSchedule({ scheduledAt: "soon", afterCurrentPass: false })).toBe(false);
    expect(
      isScanSchedule({ scheduledAt: "2026-10-02T12:00:00.000Z", afterCurrentPass: true }),
    ).toBe(false);
  });

  it("takes a Replace's stored spelling, which may be NFD", async () => {
    const response = await harness.call(owner, "POST", "/files/uploads/complete", {
      keys: ["Björk/Homogenic/01 Hunter.flac"],
    });

    expect(response.status).toBe(200);
  });

  it("works where uploads are not configured: it makes no R2 call", async () => {
    const unconfigured = filesHarness(ORIGIN);

    const response = await unconfigured.call(owner, "POST", "/files/uploads/complete", {
      keys: ["A/b.flac"],
    });

    expect(response.status).toBe(200);
    expect(await libraryChangedAt()).not.toBeNull();
  });

  it("still answers 200, with scan: null, when the driver cannot be told", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = filesHarness(ORIGIN, { scanDriver: unreachableDriver(), uploads: UPLOADS_ENV });

    const response = await failing.call(owner, "POST", "/files/uploads/complete", {
      keys: ["A/b.flac"],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ scan: null });
    expect(await libraryChangedAt()).not.toBeNull();
    expect(failing.driverCalls).toHaveLength(1);
  });

  it("answers 500 when the change cannot be recorded in D1, telling no driver", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = filesHarness(ORIGIN, { failPropertyWrite: true, uploads: UPLOADS_ENV });

    const response = await failing.call(owner, "POST", "/files/uploads/complete", {
      keys: ["A/b.flac"],
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expect(failing.driverCalls).toEqual([]);
  });

  it("answers 403 reserved_path to a key under _covers/, touching nothing", async () => {
    await expectRefusal(
      harness,
      () =>
        harness.call(owner, "POST", "/files/uploads/complete", {
          keys: ["A/b.flac", "_covers/abc.png"],
        }),
      403,
      "reserved_path",
    );
  });

  it.each([
    ["11 keys", { keys: Array.from({ length: 11 }, (_, index) => `k/${index}.flac`) }],
    ["no key", { keys: [] }],
    ["no keys field", {}],
    ["keys that are not a list", { keys: "A/b.flac" }],
    ["a key that is not a string", { keys: ["A/b.flac", 7] }],
    ["a key no upload could write", { keys: ["A/b.flac", "A/notes.pdf"] }],
    ["a hidden key", { keys: [".hidden/b.flac"] }],
    ["an empty key", { keys: [""] }],
    ["a body that is not an object", ["A/b.flac"]],
  ])("answers 400 invalid_request to %s, touching nothing", async (_, body) => {
    await expectRefusal(
      harness,
      () => harness.call(owner, "POST", "/files/uploads/complete", body),
      400,
      "invalid_request",
    );
  });

  it("answers 401 without a session, and 403 forbidden to a role without files:write", async () => {
    await expectRefusal(
      harness,
      () => harness.call(undefined, "POST", "/files/uploads/complete", { keys: ["A/b.flac"] }),
      401,
      "unauthenticated",
    );
    await expectRefusal(
      harness,
      () => harness.call(guest, "POST", "/files/uploads/complete", { keys: ["A/b.flac"] }),
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
          "/files/uploads/complete",
          { keys: ["A/b.flac"] },
          { origin: "https://evil.test" },
        ),
      403,
      "forbidden_origin",
    );
    await expectRefusal(
      harness,
      () => harness.send(plainText("/files/uploads/complete")),
      403,
      "forbidden_origin",
    );
  });

  it("answers 413 to a body over 16 KiB", async () => {
    await expectRefusal(
      harness,
      () =>
        harness.call(owner, "POST", "/files/uploads/complete", {
          keys: ["A/b.flac"],
          padding: "x".repeat(MAX_JSON_BODY_BYTES),
        }),
      413,
      "payload_too_large",
    );
  });

  it("answers 403 file_writes_disabled where FILE_WRITES is off, changing nothing", async () => {
    const preview = readOnly();
    await expectRefusal(
      preview,
      () => preview.call(owner, "POST", "/files/uploads/complete", { keys: ["A/b.flac"] }),
      403,
      "file_writes_disabled",
    );
    expect(await libraryChangedAt()).toBeNull();
  });
});

/* ===================================================== a whole upload == */

describe("an upload, signed then completed", () => {
  it("leaves the bucket alone until the browser's PUT, then records the change", async () => {
    const { uploads } = await sign([{ key: "New/01.flac", size: 10 }]);
    expect(signed(uploads[0]).key).toBe("New/01.flac");
    expect(await allKeys()).toEqual([]);
    expect(await libraryChangedAt()).toBeNull();

    // What R2 does with the URL, which miniflare cannot serve.
    await testEnv.MUSIC.put("New/01.flac", new Uint8Array(10), {
      httpMetadata: { contentType: "audio/flac" },
    });

    const complete = await harness.call(owner, "POST", "/files/uploads/complete", {
      keys: [signed(uploads[0]).key],
    });
    expect(complete.status).toBe(200);
    expect(await libraryChangedAt()).not.toBeNull();
  });
});
