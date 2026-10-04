import { SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_CALLS, CHECK_LISTINGS, SIGN_BATCH, SPELLING_LISTINGS } from "../src/api/files";
import {
  type CookieJar,
  cost,
  type RecordedStatement,
  seedConsoleUser,
  shape,
  signIn,
} from "./console-auth-support";
import { FakeS3, installFakeS3 } from "./fake-s3";
import { connectFakeLibrary, emptyFakeBucket, seedFakeObjects } from "./files-libraries-support";
import { filesHarness, inertDriver } from "./files-support";
import { seedLibraryPlaylist } from "./libraries-support";
import { resetLibrary } from "./scan-support";
import { BASE } from "./support";

/**
 * What the Files routes cost on a connected library (#84, "Free-tier
 * budget": the `GET /api/files?library=2`, `POST /api/files/uploads` and
 * `POST /api/files/uploads/check` rows), measured as test/files-budget.test.ts
 * measures library 1's: `countingD1` and `cost()` for D1, every request the
 * fake S3 endpoint received for R2, and every scan driver call, with the
 * session check apart, as the table leaves it apart.
 *
 * A connected library's route reads its library row: one D1 statement more
 * than library 1's. Subrequests count each D1 round trip, each S3 request
 * and each driver call.
 */

const ORIGIN = "https://files-libraries-budget.stratosonic.test";
const harness = filesHarness(ORIGIN, { scanDriver: inertDriver() });
const fake = new FakeS3();

/** The most D1 statements a write's session check makes (test/files-budget.test.ts). */
const WORST_SESSION_STATEMENTS = 3;

let owner: CookieJar;

beforeAll(async () => {
  await SELF.fetch(`${BASE}/rest/ping`);
  await seedConsoleUser("owner", "budget");
  owner = (await signIn(harness.send, ORIGIN, "owner", "budget")).jar;
  await connectFakeLibrary({ id: 2, name: "Archive", fake });
});

beforeEach(async () => {
  await resetLibrary();
  await emptyFakeBucket();
  installFakeS3(fake);
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Measured {
  readonly status: number;
  readonly body: unknown;
  readonly session: string[];
  readonly route: RecordedStatement[];
  readonly s3: string[];
  readonly driver: string[];
}

/** What one request cost past the console session's own check. */
async function measured(method: string, path: string, body?: unknown): Promise<Measured> {
  harness.d1.reset();
  harness.r2Calls.length = 0;
  harness.driverCalls.length = 0;
  fake.calls.length = 0;
  const response = await harness.call(owner, method, path, body);
  const statements = [...harness.d1.statements];
  const session = statements.filter((statement) =>
    ["select session", "select user"].includes(shape(statement)),
  );
  // Library 2 is never reached through the binding.
  expect(harness.r2Calls).toEqual([]);

  return {
    status: response.status,
    body: await response.json(),
    session: session.map(shape),
    route: statements.filter((statement) => !session.includes(statement)),
    s3: fake.calls.map((call) => call.operation),
    driver: [...harness.driverCalls],
  };
}

function rows(statements: readonly RecordedStatement[]) {
  return statements.map((statement) => [
    shape(statement),
    statement.rowsRead,
    statement.rowsWritten,
  ]);
}

function subrequests({ route, s3, driver }: Measured): number {
  return cost(route).roundTrips + s3.length + driver.length;
}

/** The library row, read once: one statement, one row. */
const LIBRARY_ROW = ["select library", 1, 0];

describe("the Files routes' budget on library 2", { timeout: 60_000 }, () => {
  it("GET /api/files?library=2 on a 1,000-entry folder: 1 statement, 1 row, 1 listing, 2 subrequests", async () => {
    await seedFakeObjects(
      Array.from({ length: 1000 }, (_, index) => `Big/${String(index).padStart(4, "0")}.flac`),
      100,
    );

    const result = await measured("GET", "/files?library=2&prefix=Big%2F");

    expect(result.status).toBe(200);
    expect((result.body as { files: unknown[] }).files).toHaveLength(1000);
    expect(result.session).toEqual([]);
    expect(rows(result.route)).toEqual([LIBRARY_ROW]);
    expect(cost(result.route)).toEqual({
      statements: 1,
      roundTrips: 1,
      rowsRead: 1,
      rowsWritten: 0,
    });
    expect(result.s3).toEqual(["ListObjectsV2"]);
    expect(result.driver).toEqual([]);
    expect(subrequests(result)).toBe(2);
  });

  it("POST /api/files/uploads, 10 new files: the row, 10 HeadObject and one listing that proves the bucket", async () => {
    const files = Array.from({ length: SIGN_BATCH }, (_, index) => ({
      key: `Album/${String(index).padStart(2, "0")}.flac`,
      size: 40_000_000,
    }));

    const result = await measured("POST", "/files/uploads", { library: 2, files });

    expect(result.status).toBe(200);
    expect(result.session).toEqual(["select session", "select user"]);
    expect(rows(result.route)).toEqual([LIBRARY_ROW]);
    expect(result.s3.filter((operation) => operation === "HeadObject")).toHaveLength(SIGN_BATCH);
    expect(result.s3.filter((operation) => operation === "ListObjectsV2")).toHaveLength(1);
    expect(result.driver).toEqual([]);
    expect(subrequests(result)).toBe(12);
  });

  it("POST /api/files/uploads, 10 Replace at the bound: 41 subrequests, 43 with the session", async () => {
    // Three segments that can vary in each key: the most listings a Replace makes.
    const keys = Array.from({ length: SIGN_BATCH }, (_, index) => `À/Á/${index} Â.flac`);
    await seedFakeObjects(keys);
    const files = keys.map((key) => ({ key, size: 1, overwrite: true }));

    const result = await measured("POST", "/files/uploads", { library: 2, files });

    expect(result.status).toBe(200);
    expect(
      (result.body as { uploads: { key: string }[] }).uploads.map((upload) => upload.key),
    ).toEqual(keys);
    expect(rows(result.route)).toEqual([LIBRARY_ROW]);
    expect(result.s3.filter((operation) => operation === "HeadObject")).toHaveLength(SIGN_BATCH);
    expect(result.s3.filter((operation) => operation === "ListObjectsV2")).toHaveLength(
      SIGN_BATCH * SPELLING_LISTINGS,
    );
    expect(subrequests(result)).toBe(41);
    expect(subrequests(result) + result.session.length).toBe(43);
  });

  it("POST /api/files/uploads/check at the bound: 40 listings and 6 HeadObject, 50 subrequests with a 3-statement session check", async () => {
    const keys = Array.from({ length: CHECK_CALLS + 5 }, (_, index) => `F${index}/a.flac`);

    const result = await measured("POST", "/files/uploads/check", { library: 2, keys });

    expect(result.status).toBe(200);
    expect((result.body as { unchecked: unknown[] }).unchecked).toHaveLength(5);
    expect(rows(result.route)).toEqual([LIBRARY_ROW]);
    expect(result.s3).toEqual([
      ...Array.from({ length: CHECK_LISTINGS }, () => "ListObjectsV2"),
      ...Array.from({ length: CHECK_CALLS - CHECK_LISTINGS }, () => "HeadObject"),
    ]);
    expect(result.driver).toEqual([]);
    expect(subrequests(result)).toBe(CHECK_CALLS + 1);
    expect(result.session.length).toBeLessThanOrEqual(WORST_SESSION_STATEMENTS);
    expect(subrequests(result) + WORST_SESSION_STATEMENTS).toBe(50);
  });

  it("POST /api/files/delete, 250 keys and a playlist: the row, 2 round trips, 1 DeleteObjects, 1 driver call", async () => {
    await seedLibraryPlaylist(2, "Mixes/road.m3u", "budget-owner");
    const keys = [
      "Mixes/road.m3u",
      ...Array.from({ length: 249 }, (_, index) => `Album/${String(index).padStart(3, "0")}.flac`),
    ];

    const result = await measured("POST", "/files/delete", { library: 2, keys });

    expect(result.status).toBe(200);
    expect(rows(result.route)).toEqual([
      LIBRARY_ROW,
      ["delete playlist", expect.any(Number), 1],
      ["insert property", 0, 2],
    ]);
    expect(result.s3).toEqual(["DeleteObjects"]);
    expect(result.driver).toHaveLength(1);
    expect(subrequests(result)).toBe(5);
  });

  it("POST /api/files/delete-folder, a 1,000-key round: the row, 2 listings of 500, 2 DeleteObjects", async () => {
    await seedFakeObjects(
      Array.from({ length: 1001 }, (_, index) => `Big/${String(index).padStart(4, "0")}.txt`),
      100,
    );

    const result = await measured("POST", "/files/delete-folder", { library: 2, prefix: "Big/" });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ deleted: 1000, done: false });
    expect(rows(result.route)).toEqual([LIBRARY_ROW, ["insert property", 0, 2]]);
    expect(result.s3).toEqual(["ListObjectsV2", "DeleteObjects", "ListObjectsV2", "DeleteObjects"]);
    expect(result.driver).toHaveLength(1);
    expect(subrequests(result)).toBe(7);
  });

  it("POST /api/files/uploads/complete, 10 keys: the row, 1 statement, 1 driver call, no S3 request", async () => {
    const keys = Array.from({ length: 10 }, (_, index) => `Album/${index}.flac`);

    const result = await measured("POST", "/files/uploads/complete", { library: 2, keys });

    expect(result.status).toBe(200);
    expect(rows(result.route)).toEqual([LIBRARY_ROW, ["insert property", 0, 2]]);
    expect(result.s3).toEqual([]);
    expect(result.driver).toHaveLength(1);
    expect(subrequests(result)).toBe(3);
  });
});
