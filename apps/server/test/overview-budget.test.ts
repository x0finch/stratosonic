import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import {
  type CookieJar,
  consoleRequest,
  cost,
  countingD1,
  type RecordedStatement,
  seedConsoleUser,
  shape,
  signIn,
} from "./console-auth-support";
import { BASE, seedUser, testEnv } from "./support";

/**
 * What the Overview's routes cost D1 on #82's reference library ("Free-tier
 * budget"): 5,000 tracks, 500 albums, 300 artists, 20 playlists, 5 Subsonic
 * users and 2 listening, measured with `countingD1` and `cost()` as the
 * budget table is. The session check is left out, as the table leaves it
 * out: within its cookie cache a read's `requireSession` costs no D1 at all.
 *
 * The library is written straight into D1 with one statement per table, a
 * recursive CTE counting the rows out, rather than through the seeders a row
 * at a time.
 */

const ORIGIN = "https://overview-budget.stratosonic.test";
const d1 = countingD1(testEnv.DB);
const env: Env = { ...testEnv, DB: d1.binding };
const app = createApp();
const send = (request: Request) => app.request(request, undefined, env);

const ARTISTS = 300;
const ALBUMS = 500;
const TRACKS_PER_ALBUM = 10;
const TRACKS = ALBUMS * TRACKS_PER_ALBUM;
const PLAYLISTS = 20;
const GENRES = 40;

let owner: CookieJar;

/** `n` from 0 to `count - 1`, for an `insert ... select` to count rows out with. */
function counted(count: number): string {
  return `with recursive n(i) as (select 0 union all select i + 1 from n where i < ${count - 1})`;
}

async function seedReferenceLibrary(): Promise<void> {
  const at = 1_700_000_000_000;
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `${counted(ARTISTS)} insert into artist (id, name, created_at, updated_at)
       select 'ar' || i, 'Artist ' || i, ${at}, ${at} from n`,
    ),
    testEnv.DB.prepare(
      `${counted(ALBUMS)} insert into album
         (id, name, artist_id, album_artist, year, genre, song_count, duration, size,
          created_at, updated_at)
       select 'al' || i, 'Album ' || i, 'ar' || (i % ${ARTISTS}), 'Artist ' || (i % ${ARTISTS}),
         1970 + i % 50, 'Genre ' || (i % ${GENRES}), ${TRACKS_PER_ALBUM},
         ${TRACKS_PER_ALBUM * 240.5}, ${TRACKS_PER_ALBUM * 8_000_000},
         ${at} + i * 1000, ${at} + i * 1000 from n`,
    ),
    testEnv.DB.prepare(
      `${counted(TRACKS)} insert into track
         (id, r2_key, title, album_id, artist_id, artist, album_artist, duration, size, suffix,
          genre, created_at, updated_at)
       select 'tr' || i, 'music/' || i || '.flac', 'Track ' || i,
         'al' || (i / ${TRACKS_PER_ALBUM}), 'ar' || ((i / ${TRACKS_PER_ALBUM}) % ${ARTISTS}),
         'Artist ' || ((i / ${TRACKS_PER_ALBUM}) % ${ARTISTS}),
         'Artist ' || ((i / ${TRACKS_PER_ALBUM}) % ${ARTISTS}), 240.5, 8000000, 'flac',
         'Genre ' || ((i / ${TRACKS_PER_ALBUM}) % ${GENRES}), ${at}, ${at} from n`,
    ),
  ]);

  // Five Subsonic users, the bootstrap admin among them; two are listening.
  await SELF.fetch(`${BASE}/rest/ping`);
  const userIds = [];
  for (const name of ["ann", "ben", "cat", "dan"]) {
    userIds.push(await seedUser(name, "sesame"));
  }
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `${counted(PLAYLISTS)} insert into playlist
         (id, name, owner_id, song_count, duration, r2_key, created_at, changed_at)
       select 'pl' || i, 'Playlist ' || i, ?1, 25, 6012.5, 'playlists/' || i || '.m3u',
         ${at}, ${at} from n`,
    ).bind(userIds[0]),
    ...userIds.slice(0, 2).map((userId, index) =>
      testEnv.DB.prepare(
        `insert into now_playing
           (user_id, track_id, player_name, started_at, state, position_ms, playback_rate,
            reported_at, expires_at)
         values (?1, ?2, 'Substreamer', ?3, 'playing', 1000, 1, ?3, ?4)`,
      ).bind(userId, `tr${index * 7}`, now, now + 600_000),
    ),
    // A console that has changed a file (#83), so the schedule's row is read.
    testEnv.DB.prepare(
      `insert into property (id, value) values ('LibraryChangedAt', json_object('at', ?1))`,
    ).bind(at),
  ]);
}

beforeAll(async () => {
  await seedReferenceLibrary();
  await seedConsoleUser("Owner", "overview");
  owner = (await signIn(send, ORIGIN, "owner", "overview")).jar;
});

/** How many Durable Object stubs the routes asked for since the last `measured`. */
let driverRequests = 0;

/**
 * A driver that answers the poke and runs nothing: what a pass costs is the
 * cron's row of the budget, not the button's, and a real one would sweep the
 * reference library away, a step at a time, for no reading here. It counts
 * the requests made of it, which the polled route must not make.
 */
const pokeOnly = {
  ...env,
  SCAN_DRIVER: {
    idFromName: (name: string) => testEnv.SCAN_DRIVER.idFromName(name),
    get: () => {
      driverRequests++;
      return { start: async () => "started" };
    },
  },
} as unknown as Env;

async function measured(path: string, method = "GET"): Promise<RecordedStatement[]> {
  d1.reset();
  driverRequests = 0;
  const response = await app.request(
    consoleRequest(ORIGIN, path, {
      jar: owner,
      method,
      body: method === "POST" ? {} : undefined,
    }),
    undefined,
    pokeOnly,
  );
  expect(response.status).toBe(200);
  return [...d1.statements];
}

/** Each statement as `[<verb> <table>, rows read, rows written]`. */
function rows(statements: readonly RecordedStatement[]) {
  return statements.map((statement) => [
    shape(statement),
    statement.rowsRead,
    statement.rowsWritten,
  ]);
}

describe("the overview's budget on the reference library", () => {
  it("GET /api/overview/library: one round trip of five statements, no writes", async () => {
    const statements = await measured("/api/overview/library");

    expect(cost(statements)).toEqual({
      statements: 5,
      roundTrips: 1,
      rowsRead: 11_901,
      rowsWritten: 0,
    });
    expect(rows(statements)).toEqual([
      // The counts: the artist index for `count(*)`, and every album.
      ["select album", ARTISTS + ALBUMS, 0],
      // `getGenres`' own statement. Measured at twice the tracks plus the
      // genres, not #82's estimate of the tracks once: the grouping on an
      // unindexed column goes through SQLite's sorter, which D1 counts too.
      ["select track", 2 * TRACKS + GENRES, 0],
      // `getAlbumList2?type=newest`'s: every album, and the sorter again,
      // for its first 12. An index on `album(created_at, id)` would make it
      // 12, at an index write per album upsert in every scan (#82).
      ["select album", 2 * ALBUMS, 0],
      // Each playlist, its owner by primary key, and the sorter.
      ["select playlist", 3 * PLAYLISTS, 0],
      // The libraries for the console's switch (#84): one row each.
      ["select library", 1, 0],
    ]);
  });

  it("GET /api/overview/library?library=1: the same round trip, narrowed", async () => {
    const statements = await measured("/api/overview/library?library=1");

    expect(cost(statements)).toEqual({
      statements: 5,
      roundTrips: 1,
      rowsRead: 11_601,
      rowsWritten: 0,
    });
    expect(rows(statements)).toEqual([
      // Every album, its artists counted from them rather than from the
      // artist index (an artist is in a library through its albums).
      ["select album", ALBUMS, 0],
      // The predicate only narrows: every track is still read once for its
      // library, the sorter sees fewer when other libraries hold some.
      ["select track", 2 * TRACKS + GENRES, 0],
      ["select album", 2 * ALBUMS, 0],
      // The playlists are never narrowed.
      ["select playlist", 3 * PLAYLISTS, 0],
      ["select library", 1, 0],
    ]);
  });

  it("GET /api/overview/live: one round trip of three statements, no writes", async () => {
    const statements = await measured("/api/overview/live");

    expect(cost(statements)).toEqual({
      statements: 3,
      roundTrips: 1,
      rowsRead: 17,
      rowsWritten: 0,
    });
    expect(rows(statements)).toEqual([
      // The five `property` keys, looked up by primary key: #82's three,
      // `LibraryChangedAt`, which carries the scan's schedule (#83), and
      // `ScanRowsWritten`, the daily write tally that says whether the scan
      // is paused (#84). D1 counts one row read per key looked up and one
      // more for each row found, so each costs one row read before its row
      // exists, two after, and no round trip.
      ["select property", 6, 0],
      // The libraries' names, for `scan.library` (#84): one row a library.
      ["select library", 1, 0],
      // Both sessions, each with its track, album and user by key, and the
      // sort by start.
      ["select now_playing", 10, 0],
    ]);
    // And no Durable Object request: the schedule is read from D1.
    expect(driverRequests).toBe(0);
  });

  it("POST /api/library/scan: one round trip after the session, no writes", async () => {
    const statements = await measured("/api/library/scan", "POST");
    const last = statements.at(-1)?.roundTrip;

    expect(rows(statements.filter((statement) => statement.roundTrip === last))).toEqual([
      ["select property", 6, 0],
      ["select library", 1, 0],
    ]);
    expect(driverRequests).toBe(1);
    // The rest is `requireFreshSession`'s read of the session past the
    // cookie cache, which every write pays.
    expect(statements.filter((statement) => statement.roundTrip !== last).map(shape)).toEqual([
      "select session",
      "select user",
    ]);
    expect(cost(statements).rowsWritten).toBe(0);
  });
});
