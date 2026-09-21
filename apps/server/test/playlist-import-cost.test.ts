import { beforeAll, describe, expect, it } from "vitest";
import { D1_MAX_BOUND_PARAMETERS } from "../src/d1-limits";
import { bootstrapAdmin } from "./browsing-support";
import { fixtureBytes, fixtures } from "./fixtures/files";
import {
  type CountedImport,
  importCountingWrites,
  importUntilComplete,
  playlists,
  putPlaylistObject,
} from "./playlists-support";
import { scanUntilComplete, seedFixtureFiles } from "./scan-support";
import { testEnv } from "./support";

/**
 * What a pass of the playlist import costs D1 (#61).
 *
 * The import re-reads and re-resolves every `.m3u` on every pass, which it
 * must, but until this it also rewrote every row and every entry it had just
 * written - and D1 bills per row written, so a real library of fourteen
 * playlists spent the whole free tier of 100,000 rows a day on a bucket
 * nobody had touched. A pass that resolves to what the library already holds
 * must now write nothing at all, while every pass that resolves to something
 * else must still write it.
 *
 * `importCountingWrites` runs the import against a D1 that reports
 * `meta.rows_written` per statement. What the passes *produced* is asserted
 * through the `fetch` handler, as everywhere else.
 */

const FIXTURE = fixtures.playlist;
const SILENT = "Silent Artist/Quiet Album/01 Silent Track.mp3";
const HUSHED = "Silent Artist/Quiet Album/02 Hushed Interlude.flac";
const TAIL = "Mute Ensemble/Trailing Sessions/01 Tail Loaded.m4a";
/** In the fixture playlist and in no other, so its sweep touches only that one. */
const FRONT = "Mute Ensemble/Faststart Sessions/01 Front Loaded.m4a";
/** The fixture's one line that names a track the first scan does not index. */
const NOWHERE = "Missing Artist/Missing Album/Nowhere.mp3";

const EXTRA_KEY = "playlists/extra.m3u";

/**
 * The passes run on the real clock, like the other import tests: R2 stamps an
 * object with the time it was really put, and the sweep only removes rows
 * created before the pass began.
 */
const FIRST_PASS = new Date();

function minutesLater(minutes: number): Date {
  return new Date(FIRST_PASS.getTime() + minutes * 60_000);
}

/** Writes the second playlist, whose lines each test may rearrange. */
function putExtra(keys: readonly string[]): Promise<unknown> {
  return putPlaylistObject(EXTRA_KEY, `#EXTM3U\n${keys.map((key) => `/${key}`).join("\n")}\n`);
}

/** The paths a playlist renders, in order, as a client reads them. */
async function entryPaths(key: string): Promise<string[]> {
  const listed = (await playlists("getPlaylists")).playlists?.playlist ?? [];
  const name = key
    .split("/")
    .at(-1)
    ?.replace(/\.[^.]+$/, "");
  const id = listed.find((entry) => entry.name === name)?.id ?? "";
  const response = await playlists("getPlaylist", { id });

  return (response.playlist?.entry ?? []).map((entry) => entry.path ?? "");
}

beforeAll(async () => {
  await bootstrapAdmin();
  await seedFixtureFiles();
  await putExtra([SILENT, TAIL]);
  await scanUntilComplete();
});

describe("a first pass over a bucket nothing has imported", () => {
  it("writes both playlists, and says neither was already right", async () => {
    const counted = await importCountingWrites(minutesLater(1));

    expect(counted.run.completed).toBe(true);
    expect(counted.run.counts.imported).toBe(2);
    expect(counted.run.counts.unchanged).toBe(0);
    expect(counted.playlistRowsWritten).toBeGreaterThan(0);
  });

  it("put both of them where a client can read them", async () => {
    expect(await entryPaths(EXTRA_KEY)).toEqual([SILENT, TAIL]);
    expect(await entryPaths(FIXTURE.r2Key)).toEqual([...FIXTURE.trackKeys]);
  });
});

describe("a second pass over a bucket that has not changed", () => {
  it("writes no playlist row and no entry row at all", async () => {
    const counted = await importCountingWrites(minutesLater(2));

    expect(counted.run.completed).toBe(true);
    expect(counted.run.counts.imported).toBe(2);
    expect(counted.run.counts.unchanged).toBe(2);
    expect(counted.playlistRowsWritten).toBe(0);
  });

  it("still read and re-resolved every file", async () => {
    const counted = await importCountingWrites(minutesLater(3));

    expect(counted.run.counts.entries).toBe(FIXTURE.trackKeys.length + 2);
    expect(counted.run.counts.unmatched).toBe(FIXTURE.unmatchedLineCount);
    expect(await entryPaths(FIXTURE.r2Key)).toEqual([...FIXTURE.trackKeys]);
  });

  it("touches playlist_track once for the whole listing page", async () => {
    const counted = await importCountingWrites(minutesLater(4));

    // The entries of every playlist on the page are read by one statement -
    // at most one per playlist, and here a good deal less - and a pass that
    // writes nothing runs no other statement against the table at all.
    expect(counted.statementsAgainst("playlist_track")).toHaveLength(1);
    expect(counted.run.counts.imported).toBe(2);
  });

  it("binds no statement past what D1 allows", async () => {
    const counted = await importCountingWrites(minutesLater(5));
    const bound = counted.writes.map((write) => write.bound);

    expect(bound.length).toBeGreaterThan(0);
    expect(Math.max(...bound)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
  });
});

describe("a playlist file that changed", () => {
  it("rewrites the reordered one and leaves the other alone", async () => {
    await putExtra([TAIL, SILENT]);

    const counted = await importCountingWrites(minutesLater(10));

    expect(counted.run.counts.imported).toBe(2);
    expect(counted.run.counts.unchanged).toBe(1);
    expect(counted.playlistRowsWritten).toBeGreaterThan(0);
    expect(await entryPaths(EXTRA_KEY)).toEqual([TAIL, SILENT]);
  });

  it("rewrites the one a line was added to, and nothing else", async () => {
    await putExtra([TAIL, SILENT, HUSHED]);

    const counted = await importCountingWrites(minutesLater(11));

    expect(counted.run.counts.unchanged).toBe(1);
    expect(await entryPaths(EXTRA_KEY)).toEqual([TAIL, SILENT, HUSHED]);
  });

  it("rewrites the one a line was removed from, and nothing else", async () => {
    await putExtra([TAIL, HUSHED]);

    const counted = await importCountingWrites(minutesLater(12));

    expect(counted.run.counts.unchanged).toBe(1);
    expect(await entryPaths(EXTRA_KEY)).toEqual([TAIL, HUSHED]);
  });

  it("goes quiet again on the pass after", async () => {
    const counted = await importCountingWrites(minutesLater(13));

    expect(counted.run.counts.unchanged).toBe(2);
    expect(counted.playlistRowsWritten).toBe(0);
  });
});

describe("a line that named nothing until the scan caught up", () => {
  it("rewrites the playlist that holds it once its track is indexed", async () => {
    await testEnv.MUSIC.put(NOWHERE, fixtureBytes("silent-track.mp3"));
    await scanUntilComplete();

    const counted = await importCountingWrites(minutesLater(20));

    expect(counted.run.counts.unchanged).toBe(1);
    expect(counted.playlistRowsWritten).toBeGreaterThan(0);
    expect(counted.run.counts.unmatched).toBe(0);
  });

  it("gives the playlist the entry, in the place the file lists it", async () => {
    expect(await entryPaths(FIXTURE.r2Key)).toEqual([
      FIXTURE.trackKeys[0],
      FIXTURE.trackKeys[1],
      FIXTURE.trackKeys[2],
      NOWHERE,
      FIXTURE.trackKeys[3],
    ]);
  });
});

describe("a track the scan swept", () => {
  it("drops out of the playlist on the next pass", async () => {
    await testEnv.MUSIC.delete(FRONT);
    await scanUntilComplete();

    const counted = await importCountingWrites(minutesLater(30));

    expect(counted.run.counts.unchanged).toBe(1);
    expect(counted.playlistRowsWritten).toBeGreaterThan(0);
    expect(await entryPaths(FIXTURE.r2Key)).not.toContain(FRONT);
  });

  it("leaves the entries numbered from zero without gaps", async () => {
    const paths = await entryPaths(FIXTURE.r2Key);

    expect(paths).toEqual([
      FIXTURE.trackKeys[0],
      FIXTURE.trackKeys[2],
      NOWHERE,
      FIXTURE.trackKeys[3],
    ]);
    expect((await importCountingWrites(minutesLater(31))).playlistRowsWritten).toBe(0);
  });
});

describe("a playlist long enough to need several statements", () => {
  const LINES = 120;

  it("writes it once and then leaves it alone", async () => {
    await putPlaylistObject(
      "playlists/long.m3u",
      `#EXTM3U\n${Array.from({ length: LINES }, () => `/${SILENT}`).join("\n")}\n`,
    );

    const first = await importCountingWrites(minutesLater(40));
    expect(first.run.counts.entries).toBeGreaterThanOrEqual(LINES);
    expect(first.playlistRowsWritten).toBeGreaterThan(0);
    expect(boundAtMost(first)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);

    const second = await importCountingWrites(minutesLater(41));
    expect(second.run.counts.unchanged).toBe(3);
    expect(second.playlistRowsWritten).toBe(0);
    expect(boundAtMost(second)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
  });

  it("renders every one of its entries to a client", async () => {
    expect(await entryPaths("playlists/long.m3u")).toEqual(
      Array.from({ length: LINES }, () => SILENT),
    );
  });
});

describe("a run that will not reach every playlist on the page", () => {
  it("reads the stored rows and entries only for the ones it imports", async () => {
    await putPlaylistObject("playlists/spare.m3u", `#EXTM3U\n/${SILENT}\n`);
    await putPlaylistObject("playlists/tail.m3u", `#EXTM3U\n/${TAIL}\n`);

    const counted = await importCountingWrites(minutesLater(50), { importsPerRun: 2 });

    // Five playlists are on the page and this run imports two of them, so
    // the lookups bind two keys and two ids, not five of each: the entries
    // of a playlist the run will not reach are rows read for nothing (#61).
    expect(counted.run.counts.imported).toBe(2);
    expect(counted.run.completed).toBe(false);
    expect(counted.boundAgainst("playlist")).toEqual([2]);
    expect(counted.boundAgainst("playlist_track")).toEqual([2]);
  });

  it("imports the rest over the runs that follow, and then goes quiet", async () => {
    const runs = await importUntilComplete({ importsPerRun: 2 }, minutesLater(51));

    expect(runs.at(-1)?.completed).toBe(true);
    expect(runs.at(-1)?.totals.imported).toBe(5);
    expect(await entryPaths("playlists/spare.m3u")).toEqual([SILENT]);

    const quiet = await importCountingWrites(minutesLater(60));
    expect(quiet.run.counts.unchanged).toBe(5);
    expect(quiet.playlistRowsWritten).toBe(0);
  });
});

/** The most parameters any one statement of a run bound. */
function boundAtMost(counted: CountedImport): number {
  return Math.max(...counted.writes.map((write) => write.bound));
}
