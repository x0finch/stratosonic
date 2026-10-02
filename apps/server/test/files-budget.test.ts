import { SELF } from "cloudflare:test";
import { playlistTrack } from "@stratosonic/db";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import {
  type CookieJar,
  cost,
  type RecordedStatement,
  seedConsoleUser,
  shape,
  signIn,
} from "./console-auth-support";
import { driveUntilIdle } from "./driver-support";
import {
  type FilesHarness,
  filesHarness,
  inertDriver,
  seedObjects,
  UPLOADS_ENV,
} from "./files-support";
import { resetLibrary } from "./scan-support";
import { BASE, seedPlaylist, testEnv } from "./support";

/**
 * What the Files routes cost (#83, "Free-tier budget"), measured with
 * `countingD1` and `cost()` as the budget table is, and with every call the
 * request made to the bucket's binding and to the scan driver. The session
 * check is left out, as the table leaves it out: a read's `requireSession`
 * costs nothing within the cookie cache, and a write's `requireFreshSession`
 * reads the session and its console user.
 *
 * Subrequests count each D1 round trip, each R2 binding call and each scan
 * driver call, the conservative reading scanner/scan.ts uses.
 */

const ORIGIN = "https://files-budget.stratosonic.test";
/**
 * With uploads configured, and a driver that starts no pass, so no scan runs
 * behind the large seeds. It is the first to sign in, so the isolate's Better
 * Auth instance, and with it the session check, reads its D1 binding.
 */
const harness = filesHarness(ORIGIN, { uploads: UPLOADS_ENV, scanDriver: inertDriver() });

/** Entries in the one playlist each delete takes with it. */
const ENTRIES = 25;

let owner: CookieJar;

beforeAll(async () => {
  await SELF.fetch(`${BASE}/rest/ping`);
  await seedConsoleUser("owner", "budget");
  owner = (await signIn(harness.send, ORIGIN, "owner", "budget")).jar;
});

beforeEach(async () => {
  await resetLibrary();
});

afterEach(async () => {
  await driveUntilIdle();
});

/** A playlist with `ENTRIES` entries and its `.m3u`, as an import leaves them. */
async function seedPlaylistFile(r2Key: string): Promise<void> {
  await testEnv.MUSIC.put(r2Key, "#EXTM3U\n");
  const row = await seedPlaylist({ r2Key, ownerId: "budget-owner" });
  await database(testEnv)
    .insert(playlistTrack)
    .values(
      Array.from({ length: ENTRIES }, (_, position) => ({
        playlistId: row.id,
        trackId: `tr-${position}`,
        position,
      })),
    );
}

interface Measured {
  readonly status: number;
  readonly body: unknown;
  readonly session: string[];
  readonly route: RecordedStatement[];
  readonly r2: string[];
  readonly driver: string[];
}

/** What one request cost past the console session's own check. */
async function measured(
  method: string,
  path: string,
  body?: unknown,
  on: FilesHarness = harness,
): Promise<Measured> {
  on.d1.reset();
  on.r2Calls.length = 0;
  on.driverCalls.length = 0;
  const response = await on.call(owner, method, path, body);
  const statements = [...on.d1.statements];
  const session = statements.filter((statement) =>
    ["select session", "select user"].includes(shape(statement)),
  );

  return {
    status: response.status,
    body: await response.json(),
    session: session.map(shape),
    route: statements.filter((statement) => !session.includes(statement)),
    r2: on.r2Calls.map((call) => call.method),
    driver: [...on.driverCalls],
  };
}

/** Each statement as `[<verb> <table>, rows read, rows written]`. */
function rows(statements: readonly RecordedStatement[]) {
  return statements.map((statement) => [
    shape(statement),
    statement.rowsRead,
    statement.rowsWritten,
  ]);
}

/**
 * A delete that takes one playlist of `ENTRIES` entries with it, as D1
 * counts it: the playlist's row and its entries by cascade (1 + 25 rows
 * written), then the `LibraryChangedAt` upsert (2 rows written, as D1 bills
 * an insert of a `property` row).
 */
const PLAYLIST_AND_CHANGE = [
  ["delete playlist", 76, 26],
  ["insert property", 0, 2],
];

/** The subrequests a measured request made, past the session. */
function subrequests({ route, r2, driver }: Measured): number {
  return cost(route).roundTrips + r2.length + driver.length;
}

describe("the Files routes' budget", () => {
  it("GET /api/files/config: no D1 statement, no binding call", async () => {
    const result = await measured("GET", "/files/config");

    expect(result.status).toBe(200);
    expect(result.session).toEqual([]);
    expect(cost(result.route)).toEqual({
      statements: 0,
      roundTrips: 0,
      rowsRead: 0,
      rowsWritten: 0,
    });
    expect(result.r2).toEqual([]);
    expect(result.driver).toEqual([]);
    expect(subrequests(result)).toBe(0);
  });

  it("GET /api/files on a 1,000-entry folder: one listing and no D1 statement", {
    timeout: 60_000,
  }, async () => {
    await seedObjects(
      Array.from({ length: 1000 }, (_, index) => `Big/${String(index).padStart(4, "0")}.flac`),
      100,
    );

    const result = await measured("GET", "/files?prefix=Big%2F");

    expect(result.status).toBe(200);
    expect((result.body as { files: unknown[] }).files).toHaveLength(1000);
    // No D1 statement at all, the session's included: the cookie cache vouches.
    expect(result.session).toEqual([]);
    expect(result.route).toEqual([]);
    expect(result.r2).toEqual(["list"]);
    expect(result.driver).toEqual([]);
    expect(subrequests(result)).toBe(1);
  });

  it("POST /api/files/delete, 250 keys and a playlist: 2 round trips, 1 delete, 1 driver call", {
    timeout: 60_000,
  }, async () => {
    await seedPlaylistFile("Mixes/road.m3u");
    const keys = [
      "Mixes/road.m3u",
      ...Array.from({ length: 249 }, (_, index) => `Album/${String(index).padStart(3, "0")}.flac`),
    ];
    await seedObjects(keys.slice(1), 100);

    const result = await measured("POST", "/files/delete", { keys });

    expect(result.status).toBe(200);
    expect(result.session).toEqual(["select session", "select user"]);
    expect(rows(result.route)).toEqual(PLAYLIST_AND_CHANGE);
    expect(cost(result.route)).toEqual({
      statements: 2,
      roundTrips: 2,
      rowsRead: 76,
      rowsWritten: 28,
    });
    expect(result.r2).toEqual(["delete"]);
    expect(result.driver).toHaveLength(1);
    expect(subrequests(result)).toBe(4);
  });

  it("POST /api/files/delete without a playlist: 1 round trip", { timeout: 60_000 }, async () => {
    const keys = Array.from({ length: 250 }, (_, index) => `Album/${index}.flac`);
    await seedObjects(keys, 100);

    const result = await measured("POST", "/files/delete", { keys });

    expect(result.status).toBe(200);
    expect(rows(result.route)).toEqual([["insert property", 0, 2]]);
    expect(cost(result.route)).toEqual({
      statements: 1,
      roundTrips: 1,
      rowsRead: 0,
      rowsWritten: 2,
    });
    expect(result.r2).toEqual(["delete"]);
    expect(subrequests(result)).toBe(3);
  });

  it("POST /api/files/delete-folder, a 2,000-key round: 2 listings, 2 deletes, 2 round trips", {
    timeout: 60_000,
  }, async () => {
    // Sorts first, so this round reaches it.
    await seedPlaylistFile("Big/0-road.m3u");
    await seedObjects(
      Array.from({ length: 2000 }, (_, index) => `Big/${String(index).padStart(4, "0")}.txt`),
      100,
    );

    const result = await measured("POST", "/files/delete-folder", { prefix: "Big/" });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ deleted: 2000, done: false });
    expect(result.session).toEqual(["select session", "select user"]);
    expect(rows(result.route)).toEqual(PLAYLIST_AND_CHANGE);
    expect(cost(result.route)).toEqual({
      statements: 2,
      roundTrips: 2,
      rowsRead: 76,
      rowsWritten: 28,
    });
    expect(result.r2).toEqual(["list", "delete", "list", "delete"]);
    expect(result.driver).toHaveLength(1);
    expect(subrequests(result)).toBe(7);
  });

  it.each([1, 3, 10])(
    "POST /api/files/uploads, %i files: one head() each, no D1 statement, no driver call",
    async (n) => {
      // One of them exists, which costs the same head() and no signature.
      await seedObjects(["Album/00.flac"]);
      const files = Array.from({ length: n }, (_, index) => ({
        key: `Album/${String(index).padStart(2, "0")}.flac`,
        size: 40_000_000,
      }));

      const result = await measured("POST", "/files/uploads", { files });

      expect(result.status).toBe(200);
      expect((result.body as { uploads: unknown[] }).uploads).toHaveLength(n);
      expect(result.session).toEqual(["select session", "select user"]);
      expect(result.route).toEqual([]);
      expect(result.r2).toEqual(Array.from({ length: n }, () => "head"));
      expect(result.driver).toEqual([]);
      expect(subrequests(result)).toBe(n);
    },
  );

  it("POST /api/files/uploads, not configured: nothing past the session", async () => {
    // Its session check reads the first harness's D1, so only the route's
    // own statements are counted here.
    const result = await measured(
      "POST",
      "/files/uploads",
      { files: [{ key: "Album/01.flac", size: 1 }] },
      filesHarness(ORIGIN),
    );

    expect(result.status).toBe(503);
    expect(result.route).toEqual([]);
    expect(result.r2).toEqual([]);
    expect(subrequests(result)).toBe(0);
  });

  it("POST /api/files/uploads/complete, 10 keys: 1 statement, 1 driver call, no R2 call", async () => {
    const keys = Array.from({ length: 10 }, (_, index) => `Album/${index}.flac`);

    const result = await measured("POST", "/files/uploads/complete", { keys });

    expect(result.status).toBe(200);
    expect(result.session).toEqual(["select session", "select user"]);
    expect(rows(result.route)).toEqual([["insert property", 0, 2]]);
    expect(cost(result.route)).toEqual({
      statements: 1,
      roundTrips: 1,
      rowsRead: 0,
      rowsWritten: 2,
    });
    expect(result.r2).toEqual([]);
    expect(result.driver).toHaveLength(1);
    expect(subrequests(result)).toBe(2);
  });
});
