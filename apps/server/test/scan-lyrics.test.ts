import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { type TrackLyrics, track, trackId, trackLyrics } from "@stratosonic/db";
import { asc } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { runScan } from "../src/scanner/scan";
import { fixtureBytes, fixtureLyricsTrack, fixtures } from "./fixtures/files";
import { type RecordedWrite, recordingDatabase } from "./playlists-support";
import {
  coverUploads,
  resetLibrary,
  SCAN_TIME,
  scanUntilComplete,
  storedTracks,
  UNBOUNDED_LIMITS,
} from "./scan-support";
import { testEnv } from "./support";

/**
 * Embedded lyrics at scan time: which tracks get a `track_lyrics` row, what it
 * holds, what writing it costs, and how a library indexed before the table
 * existed picks its lyrics up.
 *
 * Every test here starts from its own scan of the fixture bucket, since D1
 * and R2 are shared by the tests of one file.
 */

const USLT = fixtureLyricsTrack("lyrics-uslt.mp3");
const SYLT = fixtureLyricsTrack("lyrics-sylt.mp3");

/** Every track fixture, with lyrics or without. */
const ALL_TRACKS = [...fixtures.tracks, ...fixtures.lyricsTracks];

/** What the lyrics fixtures should leave in `track_lyrics`, in id order. */
function expectedRows(tracks = fixtures.lyricsTracks): TrackLyrics[] {
  return tracks
    .map((fixture) => ({
      trackId: trackId(fixture.r2Key),
      text: fixture.lyrics.storedText,
      lang: fixture.lyrics.lang,
    }))
    .sort((a, b) => a.trackId.localeCompare(b.trackId));
}

function storedLyrics(): Promise<TrackLyrics[]> {
  return database(testEnv).select().from(trackLyrics).orderBy(asc(trackLyrics.trackId));
}

async function putTrack(r2Key: string, file: string): Promise<void> {
  if (!(await testEnv.MUSIC.put(r2Key, fixtureBytes(file)))) {
    throw new Error(`R2 refused ${r2Key}`);
  }
}

/** A fresh library: every track fixture in the bucket, scanned once. */
async function freshLibrary(): Promise<void> {
  await resetLibrary();
  for (const fixture of ALL_TRACKS) {
    await putTrack(fixture.r2Key, fixture.file);
  }
  await scanUntilComplete();
}

/** A whole pass, run against a D1 that records what every statement wrote. */
async function passCountingWrites(): Promise<RecordedWrite[]> {
  const writes: RecordedWrite[] = [];
  const counted: Env = { ...testEnv, DB: recordingDatabase(writes) };

  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await runScan(counted, SCAN_TIME, UNBOUNDED_LIMITS)).completed) {
      return writes;
    }
  }

  throw new Error("the scan never completed");
}

/** The statements that change `track_lyrics`, rather than read it. */
function lyricsWrites(writes: readonly RecordedWrite[]): RecordedWrite[] {
  return writes.filter((write) => /^(insert into|delete from) "track_lyrics"/.test(write.sql));
}

/** Rows written to the library's own tables: everything but the scan's state. */
function libraryRowsWritten(writes: readonly RecordedWrite[]): number {
  return writes
    .filter((write) => /"(track|track_lyrics|album|artist)"/.test(write.sql))
    .filter((write) => !write.sql.startsWith("select"))
    .reduce((total, write) => total + write.rowsWritten, 0);
}

describe("a scan", () => {
  beforeAll(freshLibrary);

  it("stores the lyrics of every track whose tags carry them, and no others", async () => {
    expect(await storedLyrics()).toEqual(expectedRows());
  });

  it("writes nothing on a pass over an unchanged bucket", async () => {
    const writes = await passCountingWrites();

    expect(lyricsWrites(writes)).toEqual([]);
    expect(libraryRowsWritten(writes)).toBe(0);
    expect(await storedLyrics()).toEqual(expectedRows());
  });

  it("deletes a track's lyrics when its re-read tags no longer carry them", async () => {
    // The same key, now holding a file with no lyrics: new bytes, a new etag.
    await putTrack(USLT.r2Key, "silent-track.mp3");
    const writes = await passCountingWrites();

    expect(lyricsWrites(writes).map((write) => write.sql.split(" ")[0])).toEqual(["delete"]);
    expect(await storedLyrics()).toEqual(
      expectedRows(fixtures.lyricsTracks.filter((fixture) => fixture !== USLT)),
    );
  });

  it("stores them again when the tags come back", async () => {
    await putTrack(USLT.r2Key, USLT.file);
    const writes = await passCountingWrites();

    expect(lyricsWrites(writes).map((write) => write.sql.split(" ")[0])).toEqual(["insert"]);
    expect(await storedLyrics()).toEqual(expectedRows());
  });

  it("takes a track's lyrics with it when the sweep removes the track", async () => {
    await testEnv.MUSIC.delete(SYLT.r2Key);
    await scanUntilComplete();

    expect((await storedTracks()).map((row) => row.r2Key)).not.toContain(SYLT.r2Key);
    expect(await storedLyrics()).toEqual(
      expectedRows(fixtures.lyricsTracks.filter((fixture) => fixture !== SYLT)),
    );
  });
});

describe("a library indexed before track_lyrics existed", () => {
  const { TEST_MIGRATIONS } = env as unknown as { TEST_MIGRATIONS: D1Migration[] };
  const migration = TEST_MIGRATIONS.find((candidate) => candidate.name.startsWith("0006_"));
  let coversBefore: Map<string, number>;
  let reRead: RecordedWrite[];

  beforeAll(async () => {
    await freshLibrary();
    coversBefore = await coverUploads();

    // Back to the schema before migration 0006, keeping the library the scan
    // wrote under it - then migrate, as `wrangler d1 migrations apply` would.
    await testEnv.DB.batch([
      testEnv.DB.prepare("drop table track_lyrics"),
      testEnv.DB.prepare("delete from d1_migrations where name = ?").bind(migration?.name),
    ]);
    await applyD1Migrations(testEnv.DB, TEST_MIGRATIONS);
  });

  it("has the migration to apply", () => {
    expect(migration?.name).toBe("0006_create_track_lyrics_table.sql");
  });

  it("starts with no lyrics and every etag forgotten", async () => {
    expect(await storedLyrics()).toEqual([]);
    expect((await storedTracks()).map((row) => row.etag)).toEqual(ALL_TRACKS.map(() => ""));
  });

  it("gets every track's embedded lyrics on the next pass", async () => {
    reRead = await passCountingWrites();

    expect(await storedLyrics()).toEqual(expectedRows());
    expect((await storedTracks()).every((row) => row.etag !== "")).toBe(true);
  });

  it("writes a lyrics row for each track with lyrics, and nothing for the rest", () => {
    const writes = lyricsWrites(reRead);

    expect(writes).toHaveLength(fixtures.lyricsTracks.length);
    expect(writes.every((write) => write.sql.startsWith("insert"))).toBe(true);
  });

  it("rewrites no cover for bytes that did not change", async () => {
    expect(await coverUploads()).toEqual(coversBefore);
  });

  it("costs about what a first index of the same tracks does", () => {
    const lyricsRows = lyricsWrites(reRead).reduce((total, write) => total + write.rowsWritten, 0);
    const perTrack = (libraryRowsWritten(reRead) - lyricsRows) / ALL_TRACKS.length;

    // Each track is an artist, an album and a track upsert - seven rows with
    // their index entries, as D1 bills them - and its share of the album
    // recomputes; a track with lyrics adds its lyrics row and key.
    expect(lyricsRows).toBe(2 * fixtures.lyricsTracks.length);
    expect(perTrack).toBeGreaterThanOrEqual(7);
    expect(perTrack).toBeLessThan(9);
  });

  it("writes nothing for any track on the pass after", async () => {
    const writes = await passCountingWrites();

    expect(lyricsWrites(writes)).toEqual([]);
    expect(libraryRowsWritten(writes)).toBe(0);
    expect(await database(testEnv).select().from(track)).toHaveLength(ALL_TRACKS.length);
  });
});
