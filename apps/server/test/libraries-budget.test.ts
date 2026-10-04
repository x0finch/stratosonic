import { subsonicUser } from "@stratosonic/db";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { type CookieJar, cost, seedConsoleUser, shape, signIn } from "./console-auth-support";
import { FakeS3, installFakeS3 } from "./fake-s3";
import { librariesHarness, seedLibraryPlaylist } from "./libraries-support";
import { resetLibraries } from "./scan-libraries-support";
import { seedAlbum, seedArtist, seedUser, testEnv } from "./support";

/**
 * What the Libraries API costs (#84, "Free-tier budget"), measured with
 * `countingD1` as the table is, the console session's own check left out:
 *
 * | Request | D1 round trips | Subrequests |
 * |---|---|---|
 * | `GET /api/libraries` | 1 batch | 1 |
 * | `POST /api/libraries` | 2 (path check, insert) | 6 (+ list, probe, its delete, the poke) |
 * | `POST /api/libraries/:id/test` | 2 (the row, the stamp) | 5 (+ list, probe, its delete) |
 * | `DELETE /api/libraries/:id` | 1 batch | 2 (+ the poke) |
 *
 * A subrequest is a D1 round trip, an S3 request to the fake, or a call to
 * the scan driver.
 */

const ORIGIN = "https://libraries-budget.stratosonic.test";
const harness = librariesHarness(ORIGIN);

let owner: CookieJar;
let fake: FakeS3;
let restoreFetch: () => void;

beforeAll(async () => {
  await seedConsoleUser("owner", "budget");
  owner = (await signIn(harness.send, ORIGIN, "owner", "budget")).jar;
});

beforeEach(async () => {
  await resetLibraries();
  await database(testEnv).delete(subsonicUser);
  await seedUser("admin", "sesame", true);
  await seedUser("second", "sesame", true);
  await seedUser("listener", "pw");
  fake = new FakeS3();
  const spy = installFakeS3(fake);
  restoreFetch = () => spy.mockRestore();
});

afterEach(() => {
  restoreFetch();
});

/** What a request cost, past the console session's own check. */
async function measured(method: string, path: string, body?: unknown) {
  harness.d1.reset();
  const s3 = fake.calls.length;
  const driver = harness.driverCalls.length;
  const response = await harness.call(owner, method, path, body);
  const route = harness.d1.statements.filter(
    (statement) => !["select session", "select user"].includes(shape(statement)),
  );
  const s3Calls = fake.calls.length - s3;
  const driverCalls = harness.driverCalls.length - driver;
  const { roundTrips } = cost(route);
  return {
    status: response.status,
    body: await response.json(),
    route,
    roundTrips,
    s3Calls,
    driverCalls,
    subrequests: roundTrips + s3Calls + driverCalls,
  };
}

async function connect(): Promise<number> {
  const response = await harness.call(owner, "POST", "/libraries", {
    name: "Archive",
    accountId: fake.accountId,
    bucket: fake.bucket,
    accessKeyId: fake.accessKeyId,
    secretAccessKey: fake.secretAccessKey,
  });
  return ((await response.json()) as { library: { id: number } }).library.id;
}

describe("the Libraries API's budget", () => {
  it("GET /api/libraries: one batch, the rows and the album aggregates", async () => {
    const id = await connect();
    await seedArtist({ name: "A" });
    for (let index = 0; index < 5; index++) {
      await seedAlbum({ name: `One ${index}`, albumArtist: "A", songCount: 2 });
      await seedAlbum({ libraryId: id, name: `Two ${index}`, albumArtist: "A", songCount: 3 });
    }

    const { status, route, roundTrips, subrequests } = await measured("GET", "/libraries");

    expect(status).toBe(200);
    expect(route.map(shape)).toEqual(["select library", "select album"]);
    expect(roundTrips).toBe(1);
    expect(subrequests).toBe(1);
    // Both library rows, and the ten albums, read twice by the grouping.
    expect(route.map((statement) => [statement.rowsRead, statement.rowsWritten])).toEqual([
      [2, 0],
      [20, 0],
    ]);
  });

  it("POST /api/libraries: the path check and one insert batch, 6 subrequests", async () => {
    const { status, route, roundTrips, s3Calls, driverCalls, subrequests } = await measured(
      "POST",
      "/libraries",
      {
        name: "Archive",
        accountId: fake.accountId,
        bucket: fake.bucket,
        accessKeyId: fake.accessKeyId,
        secretAccessKey: fake.secretAccessKey,
      },
    );

    expect(status).toBe(201);
    expect(route.map(shape)).toEqual(["select library", "insert library", "insert user_library"]);
    expect(roundTrips).toBe(2);
    // ListObjectsV2 and the probe's PutObject (Class A), and its delete.
    expect(s3Calls).toBe(3);
    expect(driverCalls).toBe(1);
    expect(subrequests).toBe(6);
    // The library row, its two unique index entries (name, path) and the
    // autoincrement counter (`sqlite_sequence`), then
    // a grant per admin, each with its primary key and `library_id` entry.
    expect(route.map((statement) => statement.rowsWritten)).toEqual([0, 4, 6]);
  });

  it("POST /api/libraries/:id/test: the row and its stamp, 5 subrequests", async () => {
    const id = await connect();

    const { status, route, roundTrips, s3Calls, driverCalls, subrequests } = await measured(
      "POST",
      `/libraries/${id}/test`,
      {},
    );

    expect(status).toBe(200);
    expect(route.map(shape)).toEqual(["select library", "update library"]);
    expect(route.map((statement) => statement.rowsRead)).toEqual([1, 1]);
    expect(route.map((statement) => statement.rowsWritten)).toEqual([0, 1]);
    expect(roundTrips).toBe(2);
    expect(s3Calls).toBe(3);
    expect(driverCalls).toBe(0);
    expect(subrequests).toBe(5);
  });

  it("DELETE /api/libraries/:id: one batch and the poke, 2 subrequests", async () => {
    const id = await connect();
    await seedArtist({ name: "A" });
    await seedAlbum({ libraryId: id, name: "Two", albumArtist: "A", songCount: 3 });
    const [admin] = await database(testEnv).select().from(subsonicUser);
    await seedLibraryPlaylist(id, "playlists/one.m3u", admin?.id ?? "");
    await seedLibraryPlaylist(id, "playlists/two.m3u", admin?.id ?? "");

    const { status, body, route, roundTrips, s3Calls, driverCalls, subrequests } = await measured(
      "DELETE",
      `/libraries/${id}`,
      {},
    );

    expect(status).toBe(200);
    expect(body).toEqual({ removed: { tracks: 3, albums: 1, playlists: 2 } });
    expect(route.map(shape)).toEqual([
      // `shape` names the counts' first table: the read of the library.
      "select album",
      "update library",
      "delete user_library",
      "delete playlist",
      "insert property",
    ]);
    expect(roundTrips).toBe(1);
    expect(s3Calls).toBe(0);
    expect(driverCalls).toBe(1);
    expect(subrequests).toBe(2);
    // The state, the two admins' grants, the two playlists, and the change:
    // a few rows and one more per playlist. The counts read the library's
    // albums (here one, and the rest of the table, which has no
    // `library_id` index), its playlists through their unique index.
    expect(route.map((statement) => statement.rowsWritten)).toEqual([0, 1, 2, 2, 2]);
    expect(cost(route).rowsWritten).toBe(7);
  });
});
