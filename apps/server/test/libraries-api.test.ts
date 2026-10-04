import { DEFAULT_LIBRARY_ID, library, property, subsonicUser } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
} from "vitest";
import { MAX_JSON_BODY_BYTES } from "../src/api/json-body";
import { database } from "../src/db";
import { WRITE_PROBE_KEY } from "../src/libraries/connection";
import {
  markLibraryRemoving,
  recordConnectionTest,
  updateLibrary,
} from "../src/libraries/repository";
import { openCredentials, SEALED_PREFIX } from "../src/storage/credentials";
import { s3Path } from "../src/storage/s3";
import { type CookieJar, GUEST_ROLE, seedConsoleUser, signIn } from "./console-auth-support";
import { FakeS3, installFakeS3, libraryTestBucket } from "./fake-s3";
import { UPLOADS_ENV } from "./files-support";
import {
  expectRefusal,
  grantsOf,
  type LibraryView,
  librariesHarness,
  libraryRow,
  seedLibraryPlaylist,
  tables,
} from "./libraries-support";
import { resetLibraries } from "./scan-libraries-support";
import { encryptionKey, seedAlbum, seedArtist, seedUser, testEnv } from "./support";

/**
 * The console's Libraries API (#84, "Libraries API"; "Testing Decisions",
 * "Libraries and users APIs", "Credentials", "Removal"): connecting an R2
 * bucket served by the fake S3 endpoint (test/fake-s3.ts), editing, testing
 * and removing it, with #82's set on every route. No answer and no console
 * line of this file may carry the fake's Secret Access Key.
 */

const ORIGIN = "https://libraries.stratosonic.test";
const harness = librariesHarness(ORIGIN);
const { call, send } = harness;

let owner: CookieJar;
let guest: CookieJar;
let adminId: string;
let listenerId: string;
let fake: FakeS3;
let restoreFetch: () => void;
let consoleSpies: MockInstance[];

beforeAll(async () => {
  await seedConsoleUser("owner", "owner-password");
  await seedConsoleUser("guest", "guest-password", GUEST_ROLE);
  owner = (await signIn(send, ORIGIN, "owner", "owner-password")).jar;
  guest = (await signIn(send, ORIGIN, "guest", "guest-password")).jar;
  consoleSpies = harness.captureConsole();
});

afterAll(() => {
  for (const spy of consoleSpies) {
    spy.mockRestore();
  }
  // No answer, and no line the Worker logged, ever carried a secret.
  for (const text of [...harness.answers, ...harness.lines]) {
    expect(text).not.toContain(new FakeS3().secretAccessKey);
    expect(text).not.toContain(OTHER_SECRET);
  }
  expect(harness.answers.length).toBeGreaterThan(0);
});

beforeEach(async () => {
  await resetLibraries();
  const db = database(testEnv);
  await db.delete(subsonicUser);
  await db
    .update(library)
    .set({ name: "Music Library", defaultNewUsers: true, writable: true })
    .where(eq(library.id, DEFAULT_LIBRARY_ID));
  adminId = await seedUser("admin", "sesame", true);
  listenerId = await seedUser("listener", "pw");
  fake = new FakeS3();
  const spy = installFakeS3(fake);
  restoreFetch = () => spy.mockRestore();
});

afterEach(() => {
  restoreFetch();
});

/** A second token, for a key change. */
const OTHER_KEY_ID = "other-access-key-id-0000000000A1B2";
const OTHER_SECRET = "other/secret+access=key-not-real";

function connectBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Archive",
    accountId: fake.accountId,
    bucket: fake.bucket,
    accessKeyId: fake.accessKeyId,
    secretAccessKey: fake.secretAccessKey,
    ...overrides,
  };
}

async function connect(overrides: Record<string, unknown> = {}): Promise<LibraryView> {
  const response = await call(owner, "POST", "/libraries", connectBody(overrides));
  expect(response.status).toBe(201);
  return ((await response.json()) as { library: LibraryView }).library;
}

async function listed(): Promise<{ libraries: LibraryView[]; defaultAccountId: string | null }> {
  const response = await call(owner, "GET", "/libraries");
  expect(response.status).toBe(200);
  return (await response.json()) as { libraries: LibraryView[]; defaultAccountId: string | null };
}

/** What `getMusicFolders` answers a Subsonic user, by id. */
async function musicFolders(username: string, password: string): Promise<number[]> {
  const query = new URLSearchParams({
    u: username,
    p: password,
    v: "1.16.1",
    c: "test",
    f: "json",
  });
  const response = await send(new Request(`${ORIGIN}/rest/getMusicFolders?${query}`));
  const body = (await response.json()) as {
    "subsonic-response": { musicFolders?: { musicFolder?: { id: number }[] } };
  };
  return (body["subsonic-response"].musicFolders?.musicFolder ?? []).map((folder) => folder.id);
}

/** #82's refusals, before a write reads its body, D1, the bucket or the driver. */
function itRefusesWhatEveryWriteRefuses(
  method: string,
  path: () => string | Promise<string>,
  body: () => unknown,
) {
  it("refuses a request without a session", async () => {
    const at = await path();
    await expectRefusal(harness, fake, () => call(undefined, method, at, body()), 401, {
      error: "unauthenticated",
    });
  });

  it("refuses a console user whose role lacks libraries:write", async () => {
    const at = await path();
    await expectRefusal(harness, fake, () => call(guest, method, at, body()), 403, {
      error: "forbidden",
    });
  });

  it("refuses a cross-origin request", async () => {
    const at = await path();
    await expectRefusal(
      harness,
      fake,
      () => call(owner, method, at, body(), { origin: "https://evil.example" }),
      403,
      { error: "forbidden_origin" },
    );
  });

  it("refuses a body over the cap", async () => {
    const at = await path();
    await expectRefusal(
      harness,
      fake,
      () => call(owner, method, at, { padding: "x".repeat(MAX_JSON_BODY_BYTES) }),
      413,
      { error: "payload_too_large" },
    );
  });

  it("refuses a body that is not a JSON object", async () => {
    const at = await path();
    await expectRefusal(harness, fake, () => call(owner, method, at, [body()]), 400, {
      error: "invalid_request",
    });
  });
}

describe("GET /api/libraries", () => {
  it("lists every library with its counts, and never a key", async () => {
    const connected = await connect();
    await seedArtist({ name: "Shared" });
    await seedArtist({ name: "Two" });
    await seedAlbum({ name: "A", albumArtist: "Shared", songCount: 3, size: 300, duration: 90.4 });
    for (const [name, artist] of [
      ["B", "Shared"],
      ["C", "Two"],
    ] as const) {
      await seedAlbum({
        libraryId: connected.id,
        name,
        albumArtist: artist,
        songCount: 2,
        size: 1_000,
        duration: 60.3,
      });
    }

    const { libraries, defaultAccountId } = await listed();

    expect(defaultAccountId).toBeNull();
    expect(libraries).toEqual([
      {
        id: 1,
        name: "Music Library",
        kind: "r2-binding",
        accountId: null,
        bucket: "navidrome",
        accessKeyIdHint: null,
        writable: true,
        defaultNewUsers: true,
        state: "active",
        lastScanStartedAt: null,
        lastScanAt: null,
        lastScanError: null,
        counts: { artists: 1, albums: 1, tracks: 3, sizeBytes: 300, durationSec: 90 },
      },
      {
        id: connected.id,
        name: "Archive",
        kind: "s3",
        accountId: fake.accountId,
        bucket: fake.bucket,
        accessKeyIdHint: `…${fake.accessKeyId.slice(-4)}`,
        writable: true,
        defaultNewUsers: false,
        state: "active",
        lastScanStartedAt: null,
        lastScanAt: null,
        lastScanError: null,
        counts: { artists: 2, albums: 2, tracks: 4, sizeBytes: 2_000, durationSec: 121 },
      },
    ]);
  });

  it("prefills the account from CF_ACCOUNT_ID, and names it for library 1", async () => {
    const configured = librariesHarness(ORIGIN, { uploads: UPLOADS_ENV });
    const response = await configured.call(owner, "GET", "/libraries");
    const body = (await response.json()) as { libraries: LibraryView[]; defaultAccountId: string };

    expect(body.defaultAccountId).toBe(UPLOADS_ENV.CF_ACCOUNT_ID);
    expect(body.libraries[0]).toMatchObject({ id: 1, accountId: UPLOADS_ENV.CF_ACCOUNT_ID });
  });

  it("answers 401 without a session, and 403 forbidden to a role without libraries:read", async () => {
    expect((await call(undefined, "GET", "/libraries")).status).toBe(401);
    const forbidden = await call(guest, "GET", "/libraries");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden" });
  });
});

describe("POST /api/libraries", () => {
  it("tests, stores the token sealed, grants every admin, and pokes the driver", async () => {
    const response = await call(owner, "POST", "/libraries", connectBody({ name: "  Archive  " }));

    expect(response.status).toBe(201);
    const body = (await response.json()) as { library: LibraryView; scan: string };
    expect(body.scan).toBe("started");
    expect(body.library).toMatchObject({
      name: "Archive",
      kind: "s3",
      accountId: fake.accountId,
      bucket: fake.bucket,
      accessKeyIdHint: `…${fake.accessKeyId.slice(-4)}`,
      writable: true,
      defaultNewUsers: false,
      state: "active",
      counts: { artists: 0, albums: 0, tracks: 0, sizeBytes: 0, durationSec: 0 },
    });

    // The test: a listing of one key, the probe written and deleted.
    expect(fake.calls.map((entry) => [entry.operation, entry.key ?? null])).toEqual([
      ["ListObjectsV2", null],
      ["PutObject", WRITE_PROBE_KEY],
      ["DeleteObjects", null],
    ]);
    expect(fake.calls[0]?.url).toContain("max-keys=1");
    expect(await libraryTestBucket().head(WRITE_PROBE_KEY)).toBeNull();

    const row = await libraryRow(body.library.id);
    const path = s3Path({ endpoint: fake.endpoint, bucket: fake.bucket });
    expect(row).toMatchObject({
      path,
      kind: "s3",
      endpoint: `https://${fake.accountId}.r2.cloudflarestorage.com`,
      region: "auto",
      bucket: fake.bucket,
    });
    expect(row?.credentials).toMatch(new RegExp(`^${SEALED_PREFIX.replaceAll("$", "\\$")}`));
    expect(row?.credentials).not.toContain(fake.secretAccessKey);
    expect(await openCredentials(encryptionKey(), path, row?.credentials ?? "")).toEqual(
      fake.credentials(),
    );

    expect(await grantsOf(adminId)).toEqual([1, body.library.id]);
    expect(await grantsOf(listenerId)).toEqual([1]);
    expect(harness.driverCalls.at(-1)).toBe("start");
    // The admin sees it on the next request; the listener does not.
    expect(await musicFolders("admin", "sesame")).toEqual([1, body.library.id]);
    expect(await musicFolders("listener", "pw")).toEqual([1]);
  });

  it("connects a read-only token, which the write probe finds", async () => {
    fake.fail("access_denied", ["PutObject"]);

    const created = await connect();

    expect(created.writable).toBe(false);
    expect(fake.calls.map((entry) => entry.operation)).toEqual(["ListObjectsV2", "PutObject"]);
  });

  it.each([
    ["the key is refused", "access_denied", "auth"],
    ["the bucket is missing", "no_such_bucket", "bucket_not_found"],
    ["the bucket does not answer", "server_error", "unavailable"],
  ] as const)("stores nothing when %s: 422 connection_failed", async (_, failure, reason) => {
    fake.fail(failure);
    const before = await tables();
    const driverCalls = harness.driverCalls.length;

    const response = await call(owner, "POST", "/libraries", connectBody());

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "connection_failed", reason });
    expect(await tables()).toEqual(before);
    expect(harness.driverCalls.length).toBe(driverCalls);
  });

  it("answers bucket_not_found for a bucket the account does not have", async () => {
    const response = await call(owner, "POST", "/libraries", connectBody({ bucket: "missing" }));
    expect(await response.json()).toEqual({
      error: "connection_failed",
      reason: "bucket_not_found",
    });
  });

  it.each([
    ["an empty name", { name: "   " }, 400, "invalid_request"],
    ["a name over 64 characters", { name: "n".repeat(65) }, 400, "invalid_request"],
    ["a name that is not a string", { name: 7 }, 400, "invalid_request"],
    ["a missing key", { secretAccessKey: undefined }, 400, "invalid_request"],
    ["an empty key", { accessKeyId: " " }, 400, "invalid_request"],
    ["a defaultNewUsers that is not a boolean", { defaultNewUsers: "yes" }, 400, "invalid_request"],
    [
      "an account id in capitals",
      { accountId: "FEDCBA9876543210FEDCBA9876543210" },
      400,
      "invalid_account_id",
    ],
    ["a short account id", { accountId: "fedcba98" }, 400, "invalid_account_id"],
    ["a host for an account id", { accountId: "evil.example/x" }, 400, "invalid_account_id"],
    ["a bucket in capitals", { bucket: "Archive" }, 400, "invalid_bucket"],
    ["a bucket of two characters", { bucket: "ab" }, 400, "invalid_bucket"],
    ["a bucket ending in a hyphen", { bucket: "archive-" }, 400, "invalid_bucket"],
    ["a bucket with a slash", { bucket: "a/b" }, 400, "invalid_bucket"],
  ])("refuses %s", async (_, overrides, status, error) => {
    await expectRefusal(
      harness,
      fake,
      () => call(owner, "POST", "/libraries", connectBody(overrides)),
      status,
      { error },
    );
  });

  it("refuses a name another library has in any case: 409 name_taken", async () => {
    await expectRefusal(
      harness,
      fake,
      () => call(owner, "POST", "/libraries", connectBody({ name: "MUSIC library" })),
      409,
      { error: "name_taken" },
    );
  });

  it("refuses the bucket a library has: 409 already_connected", async () => {
    await connect();
    await expectRefusal(
      harness,
      fake,
      () => call(owner, "POST", "/libraries", connectBody({ name: "Again" })),
      409,
      { error: "already_connected" },
    );
  });

  it("refuses the bound bucket: 409 already_connected", async () => {
    const bound = librariesHarness(ORIGIN, { uploads: UPLOADS_ENV });
    await expectRefusal(
      bound,
      fake,
      () =>
        bound.call(
          owner,
          "POST",
          "/libraries",
          connectBody({ accountId: UPLOADS_ENV.CF_ACCOUNT_ID, bucket: UPLOADS_ENV.R2_BUCKET_NAME }),
        ),
      409,
      { error: "already_connected" },
    );
  });

  it("gives default_new_users libraries to the next new user only", async () => {
    const created = await connect({ defaultNewUsers: true });
    expect(created.defaultNewUsers).toBe(true);
    // Users that existed keep what they had.
    expect(await grantsOf(listenerId)).toEqual([1]);

    const response = await call(owner, "POST", "/subsonic-users", {
      username: "newcomer",
      password: "pw",
    });
    const { user } = (await response.json()) as { user: { id: string; libraryIds: number[] } };
    expect(user.libraryIds).toEqual([1, created.id]);
    expect(await grantsOf(user.id)).toEqual([1, created.id]);
    expect(await grantsOf(listenerId)).toEqual([1]);
  });

  itRefusesWhatEveryWriteRefuses(
    "POST",
    () => "/libraries",
    () => connectBody(),
  );
});

describe("PATCH /api/libraries/:id", () => {
  it("renames a library and sets its default flag without a test", async () => {
    const created = await connect();
    const calls = fake.calls.length;
    const driverCalls = harness.driverCalls.length;

    const response = await call(owner, "PATCH", `/libraries/${created.id}`, {
      name: "Old Records",
      defaultNewUsers: true,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { library: LibraryView; scan: null };
    expect(body).toMatchObject({
      library: { id: created.id, name: "Old Records", defaultNewUsers: true },
      scan: null,
    });
    expect(fake.calls.length).toBe(calls);
    expect(harness.driverCalls.length).toBe(driverCalls);
  });

  it("takes the two keys together only", async () => {
    const created = await connect();
    for (const keys of [{ accessKeyId: OTHER_KEY_ID }, { secretAccessKey: OTHER_SECRET }]) {
      await expectRefusal(
        harness,
        fake,
        () => call(owner, "PATCH", `/libraries/${created.id}`, keys),
        400,
        { error: "invalid_request" },
      );
    }
  });

  it("refuses an empty change, and a name another library has", async () => {
    const created = await connect();
    await expectRefusal(
      harness,
      fake,
      () => call(owner, "PATCH", `/libraries/${created.id}`, {}),
      400,
      {
        error: "invalid_request",
      },
    );
    await expectRefusal(
      harness,
      fake,
      () => call(owner, "PATCH", `/libraries/${created.id}`, { name: "music LIBRARY" }),
      409,
      { error: "name_taken" },
    );
  });

  it("takes only a name and the default flag for library 1", async () => {
    const response = await call(owner, "PATCH", "/libraries/1", {
      name: "Main",
      defaultNewUsers: false,
    });
    expect(response.status).toBe(200);
    expect(await libraryRow(1)).toMatchObject({
      name: "Main",
      defaultNewUsers: false,
      path: "r2-binding://MUSIC",
      kind: "r2-binding",
    });

    for (const change of [
      { bucket: "other" },
      { accountId: fake.accountId },
      { accessKeyId: OTHER_KEY_ID, secretAccessKey: OTHER_SECRET },
    ]) {
      await expectRefusal(harness, fake, () => call(owner, "PATCH", "/libraries/1", change), 409, {
        error: "default_library",
      });
    }
  });

  it("replaces the key: re-tests, re-seals under the same path, and resets nothing", async () => {
    const created = await connect();
    const before = await libraryRow(created.id);
    await seedScanState(created.id);
    const accepting = new FakeS3({ accessKeyId: OTHER_KEY_ID, secretAccessKey: OTHER_SECRET });
    restoreFetch();
    const spy = installFakeS3(accepting);
    restoreFetch = () => spy.mockRestore();
    const driverCalls = harness.driverCalls.length;

    const response = await call(owner, "PATCH", `/libraries/${created.id}`, {
      accessKeyId: OTHER_KEY_ID,
      secretAccessKey: OTHER_SECRET,
    });

    expect(response.status).toBe(200);
    const { library: view } = (await response.json()) as { library: LibraryView };
    expect(view.accessKeyIdHint).toBe(`…${OTHER_KEY_ID.slice(-4)}`);
    expect(accepting.calls.map((entry) => entry.operation)).toEqual([
      "ListObjectsV2",
      "PutObject",
      "DeleteObjects",
    ]);
    const after = await libraryRow(created.id);
    expect(after?.path).toBe(before?.path);
    expect(after?.credentials).not.toBe(before?.credentials);
    expect(
      await openCredentials(encryptionKey(), after?.path ?? "", after?.credentials ?? ""),
    ).toEqual({
      accessKeyId: OTHER_KEY_ID,
      secretAccessKey: OTHER_SECRET,
    });
    expect(await scanState(created.id)).toEqual(SEEDED_STATE);
    expect(harness.driverCalls.length).toBe(driverCalls);
  });

  it("moves to another bucket: re-seals under the new path, resets the scan, pokes", async () => {
    const created = await connect();
    const before = await libraryRow(created.id);
    await seedScanState(created.id);
    const moved = new FakeS3({
      accountId: "0123456789abcdef0123456789abcdef",
      bucket: "archive-two",
    });
    restoreFetch();
    const spy = installFakeS3(fake, moved);
    restoreFetch = () => spy.mockRestore();

    const response = await call(owner, "PATCH", `/libraries/${created.id}`, {
      accountId: moved.accountId,
      bucket: moved.bucket,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { library: LibraryView; scan: string };
    expect(body).toMatchObject({
      library: { id: created.id, accountId: moved.accountId, bucket: moved.bucket },
      scan: "started",
    });
    // The stored token, tested against the new bucket.
    expect(moved.calls.map((entry) => entry.operation)).toEqual([
      "ListObjectsV2",
      "PutObject",
      "DeleteObjects",
    ]);
    const after = await libraryRow(created.id);
    const newPath = s3Path({ endpoint: moved.endpoint, bucket: moved.bucket });
    expect(after).toMatchObject({ path: newPath, endpoint: moved.endpoint, bucket: moved.bucket });
    // Sealed for the new path: the old ciphertext no longer opens under it,
    // and the new one does not open under the old path.
    await expect(
      openCredentials(encryptionKey(), newPath, before?.credentials ?? ""),
    ).rejects.toThrow();
    await expect(
      openCredentials(encryptionKey(), before?.path ?? "", after?.credentials ?? ""),
    ).rejects.toThrow();
    expect(await openCredentials(encryptionKey(), newPath, after?.credentials ?? "")).toEqual(
      fake.credentials(),
    );
    // The library's cursor and memo start over; another library's memo stays.
    expect(await scanState(created.id)).toEqual({
      progress: {
        ...SEEDED_PROGRESS(created.id),
        cursor: "",
        skip: 0,
        sweptTo: "",
        restarted: false,
      },
      memo: null,
      otherMemo: SEEDED_STATE.otherMemo,
    });
    expect(harness.driverCalls.at(-1)).toBe("start");
  });

  it("stores nothing when the new bucket fails its test", async () => {
    const created = await connect();
    const before = await tables();

    const response = await call(owner, "PATCH", `/libraries/${created.id}`, { bucket: "missing" });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "connection_failed",
      reason: "bucket_not_found",
    });
    expect(await tables()).toEqual(before);
  });

  it("refuses a bucket another library has, and the bound bucket", async () => {
    const first = await connect();
    const second = new FakeS3({ accountId: "00112233445566778899aabbccddeeff", bucket: "second" });
    restoreFetch();
    const spy = installFakeS3(fake, second);
    restoreFetch = () => spy.mockRestore();
    const other = await connect({ name: "Second", accountId: second.accountId, bucket: "second" });

    await expectRefusal(
      harness,
      fake,
      () =>
        call(owner, "PATCH", `/libraries/${other.id}`, {
          accountId: fake.accountId,
          bucket: fake.bucket,
        }),
      409,
      { error: "already_connected" },
    );
    const bound = librariesHarness(ORIGIN, { uploads: UPLOADS_ENV });
    await expectRefusal(
      bound,
      fake,
      () =>
        bound.call(owner, "PATCH", `/libraries/${first.id}`, {
          accountId: UPLOADS_ENV.CF_ACCOUNT_ID,
          bucket: UPLOADS_ENV.R2_BUCKET_NAME,
        }),
      409,
      { error: "already_connected" },
    );
  });

  it("answers 404 for an unknown library, and 409 removing for one being removed", async () => {
    await expectRefusal(
      harness,
      fake,
      () => call(owner, "PATCH", "/libraries/999", { name: "X" }),
      404,
      {
        error: "not_found",
      },
    );
    await expectRefusal(
      harness,
      fake,
      () => call(owner, "PATCH", "/libraries/abc", { name: "X" }),
      404,
      {
        error: "not_found",
      },
    );
    const created = await connect();
    expect((await call(owner, "DELETE", `/libraries/${created.id}`, {})).status).toBe(200);
    for (const change of [{ name: "Back" }, { defaultNewUsers: true }, { bucket: "other" }]) {
      await expectRefusal(
        harness,
        fake,
        () => call(owner, "PATCH", `/libraries/${created.id}`, change),
        409,
        { error: "removing" },
      );
    }
    expect((await libraryRow(created.id))?.state).toBe("removing");
  });

  itRefusesWhatEveryWriteRefuses(
    "PATCH",
    async () => `/libraries/${(await connect({ name: `Refused ${Math.random()}` })).id}`,
    () => ({ name: "Renamed" }),
  );
});

describe("POST /api/libraries/:id/test", () => {
  async function test(id: number) {
    const response = await call(owner, "POST", `/libraries/${id}/test`, {});
    expect(response.status).toBe(200);
    return response.json();
  }

  it("finds a library readable and writable", async () => {
    const created = await connect();
    await database(testEnv)
      .update(library)
      .set({ writable: false, lastScanError: "auth" })
      .where(eq(library.id, created.id));
    fake.calls.length = 0;

    expect(await test(created.id)).toEqual({ ok: true, writable: true });
    expect(fake.calls.map((entry) => entry.operation)).toEqual([
      "ListObjectsV2",
      "PutObject",
      "DeleteObjects",
    ]);
    expect(await libraryRow(created.id)).toMatchObject({ writable: true, lastScanError: null });
  });

  it("finds a library read-only when the probe is refused", async () => {
    const created = await connect();
    fake.fail("access_denied", ["PutObject"]);

    expect(await test(created.id)).toEqual({ ok: true, writable: false });
    expect(await libraryRow(created.id)).toMatchObject({ writable: false, lastScanError: null });
  });

  it("deletes a probe a crashed test left, which still proves write access", async () => {
    const created = await connect();
    await libraryTestBucket().put(WRITE_PROBE_KEY, new Uint8Array(0));
    fake.calls.length = 0;

    expect(await test(created.id)).toEqual({ ok: true, writable: true });
    expect(fake.calls.map((entry) => [entry.operation, entry.status])).toEqual([
      ["ListObjectsV2", 200],
      ["PutObject", 412],
      ["DeleteObjects", 200],
    ]);
    expect(await libraryTestBucket().head(WRITE_PROBE_KEY)).toBeNull();
  });

  it.each([
    ["access_denied", "auth"],
    ["no_such_bucket", "bucket_not_found"],
    ["network", "unavailable"],
  ] as const)("reports a %s failure, and keeps writable", async (failure, reason) => {
    const created = await connect();
    fake.fail(failure);

    expect(await test(created.id)).toEqual({ ok: false, reason });
    expect(await libraryRow(created.id)).toMatchObject({ writable: true, lastScanError: reason });
  });

  it("reports auth for a token that no longer opens", async () => {
    const created = await connect();
    await database(testEnv)
      .update(library)
      .set({ credentials: "aes-256-gcm$v1$AAAA$AAAA" })
      .where(eq(library.id, created.id));
    fake.calls.length = 0;

    expect(await test(created.id)).toEqual({ ok: false, reason: "auth" });
    expect(fake.calls).toEqual([]);
  });

  it("lists library 1 through the binding, and says whether uploads are configured", async () => {
    expect(await test(1)).toEqual({ ok: true, writable: true, uploads: false });
    const configured = librariesHarness(ORIGIN, { uploads: UPLOADS_ENV });
    const response = await configured.call(owner, "POST", "/libraries/1/test", {});
    expect(await response.json()).toEqual({ ok: true, writable: true, uploads: true });
    expect(fake.calls).toEqual([]);
  });

  it("answers 404 for an unknown library, and 409 removing for one being removed", async () => {
    await expectRefusal(harness, fake, () => call(owner, "POST", "/libraries/999/test", {}), 404, {
      error: "not_found",
    });
    const created = await connect();
    expect((await call(owner, "DELETE", `/libraries/${created.id}`, {})).status).toBe(200);
    await expectRefusal(
      harness,
      fake,
      () => call(owner, "POST", `/libraries/${created.id}/test`, {}),
      409,
      { error: "removing" },
    );
  });

  itRefusesWhatEveryWriteRefuses(
    "POST",
    async () => `/libraries/${(await connect({ name: `Tested ${Math.random()}` })).id}/test`,
    () => ({}),
  );
});

describe("DELETE /api/libraries/:id", () => {
  it("hides the library at once, drops its grants and playlists, and touches no bucket", async () => {
    const created = await connect({ defaultNewUsers: true });
    const both = await seedUser("both", "pw");
    // A new non-admin gets the default libraries, this one included.
    expect(await grantsOf(both)).toEqual([1, created.id]);
    await seedArtist({ name: "Two" });
    await seedAlbum({ libraryId: created.id, name: "B", albumArtist: "Two", songCount: 7 });
    const kept = await seedLibraryPlaylist(1, "playlists/kept.m3u", adminId);
    await seedLibraryPlaylist(created.id, "playlists/gone.m3u", adminId);
    await seedLibraryPlaylist(created.id, "playlists/also-gone.m3u", listenerId);
    expect(await musicFolders("admin", "sesame")).toEqual([1, created.id]);
    expect(await musicFolders("both", "pw")).toEqual([1, created.id]);
    fake.calls.length = 0;

    const response = await call(owner, "DELETE", `/libraries/${created.id}`, {});

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: { tracks: 7, albums: 1, playlists: 2 } });
    expect((await libraryRow(created.id))?.state).toBe("removing");
    // Gone for every reader, the admin too.
    expect(await musicFolders("admin", "sesame")).toEqual([1]);
    expect(await musicFolders("both", "pw")).toEqual([1]);
    const after = await tables();
    expect(after.grants.filter((grant) => grant.libraryId === created.id)).toEqual([]);
    expect(after.playlists.map((row) => row.id)).toEqual([kept]);
    expect(after.properties.map((row) => row.id)).toContain("LibraryChangedAt");
    expect(fake.calls).toEqual([]);
    expect(harness.driverCalls.at(-1)).toBe("start");
    // A library being removed is no default for a new user.
    const newcomer = await call(owner, "POST", "/subsonic-users", {
      username: "late",
      password: "pw",
    });
    expect(((await newcomer.json()) as { user: { libraryIds: number[] } }).user.libraryIds).toEqual(
      [1],
    );
    // Nor given to a new admin.
    const admin = await call(owner, "POST", "/subsonic-users", {
      username: "boss",
      password: "pw",
      isAdmin: true,
    });
    const { user } = (await admin.json()) as { user: { id: string } };
    expect(await grantsOf(user.id)).toEqual([1]);
  });

  it("refuses library 1: 409 default_library", async () => {
    await expectRefusal(harness, fake, () => call(owner, "DELETE", "/libraries/1", {}), 409, {
      error: "default_library",
    });
  });

  it("refuses a library already being removed, and an unknown one", async () => {
    const created = await connect();
    expect((await call(owner, "DELETE", `/libraries/${created.id}`, {})).status).toBe(200);
    await expectRefusal(
      harness,
      fake,
      () => call(owner, "DELETE", `/libraries/${created.id}`, {}),
      409,
      {
        error: "removing",
      },
    );
    await expectRefusal(harness, fake, () => call(owner, "DELETE", "/libraries/999", {}), 404, {
      error: "not_found",
    });
  });

  it("never marks library 1 removing, whatever the request", async () => {
    // Even straight through the repository, the guard is in the statement,
    // and the batch's other writes wait on it: library 1's grants and
    // playlists stay.
    await seedLibraryPlaylist(1, "playlists/one.m3u", adminId);
    const before = await tables();
    expect(await markLibraryRemoving(database(testEnv), 1)).toEqual({
      refused: "default_library",
    });
    expect(await tables()).toEqual(before);
    expect((await libraryRow(1))?.state).toBe("active");
  });

  it("never writes a library being removed again, so it never comes back", async () => {
    // The guards are in the statements, past the routes' own checks: a
    // write racing the removal finds the library gone.
    const created = await connect();
    expect((await call(owner, "DELETE", `/libraries/${created.id}`, {})).status).toBe(200);
    await seedScanState(created.id);
    const before = await tables();
    const db = database(testEnv);

    expect(await updateLibrary(db, created.id, { name: "Back" }, true)).toBeNull();
    await recordConnectionTest(db, created.id, { writable: false, error: null });

    expect(await tables()).toEqual(before);
    expect((await libraryRow(created.id))?.state).toBe("removing");
  });

  itRefusesWhatEveryWriteRefuses(
    "DELETE",
    async () => `/libraries/${(await connect({ name: `Removed ${Math.random()}` })).id}`,
    () => ({}),
  );
});

/* ------------------------------------------------------------ helpers -- */

/** A pass in the middle of library `id`, and memos for it and for library 1. */
function SEEDED_PROGRESS(id: number) {
  return {
    startedAt: 1_000,
    libraryId: id,
    cursor: "page-7",
    skip: 3,
    sweptTo: "M/N/07.mp3",
    restarted: true,
    counts: { examined: 0 },
  };
}

const SEEDED_STATE = {
  progress: null as unknown,
  memo: { "b.mp3": "e2" } as unknown,
  otherMemo: { "a.mp3": "e1" } as unknown,
};

async function seedScanState(id: number): Promise<void> {
  SEEDED_STATE.progress = SEEDED_PROGRESS(id);
  await database(testEnv)
    .insert(property)
    .values([
      { id: "ScanProgress", value: JSON.stringify(SEEDED_PROGRESS(id)) },
      { id: "BrokenObjects", value: JSON.stringify(SEEDED_STATE.otherMemo) },
      { id: `BrokenObjects:${id}`, value: JSON.stringify(SEEDED_STATE.memo) },
    ]);
}

async function scanState(id: number) {
  const rows = await database(testEnv).select().from(property);
  const value = (key: string) => {
    const row = rows.find((entry) => entry.id === key);
    return row === undefined ? null : JSON.parse(row.value);
  };
  return {
    progress: value("ScanProgress"),
    memo: value(`BrokenObjects:${id}`),
    otherMemo: value("BrokenObjects"),
  };
}
