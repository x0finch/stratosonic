import { nowPlaying } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { albumsQuery, listAlbums, toAlbumViews } from "../src/library/lists";
import { listNowPlaying, nowPlayingQuery, toNowPlayingEntries } from "../src/nowplaying/repository";
import { readScanReport, scanReportQuery, toScanReport } from "../src/scanner/state";
import { SEED_TIME, seedAnnotation, seedFixtureLibrary, seedUser, testEnv } from "./support";

/**
 * The joined reads the Overview sends in a `db.batch` (api/overview.ts) must
 * answer exactly what they answer alone.
 *
 * They need not: Drizzle reads a batched result by column position from
 * D1's row objects (`d1ToRawMapping` in drizzle-orm/d1/session.js), and an
 * object keeps one value per column *name*. A joined select whose tables
 * share a column name would have one column silently dropped and every later
 * one read into the wrong field, in the batch only. These reads carry a real
 * caller's annotation, so its columns hold values rather than the nulls of a
 * join that matches nothing, and a column a later change lets collide fails
 * here instead of corrupting the console.
 */

let callerId: string;
const now = new Date();

beforeAll(async () => {
  const { albums, tracks } = await seedFixtureLibrary();
  callerId = await seedUser("caller", "sesame", true);
  const otherId = await seedUser("other", "sesame");

  for (const [index, entry] of albums.entries()) {
    await seedAnnotation({
      userId: callerId,
      itemId: entry.id,
      itemType: "album",
      starred: index % 2 === 0,
      rating: (index % 5) + 1,
      playCount: index + 3,
      playDate: new Date(SEED_TIME.getTime() + index * 60_000),
    });
  }

  const [first, second] = tracks;
  if (!first || !second) {
    throw new Error("the fixtures have fewer than two tracks");
  }
  for (const [index, entry] of [first, second].entries()) {
    await seedAnnotation({
      userId: callerId,
      itemId: entry.id,
      itemType: "track",
      rating: 4 - index,
      playCount: 7 + index,
      playDate: new Date(SEED_TIME.getTime() + index),
    });
  }

  await database(testEnv)
    .insert(nowPlaying)
    .values(
      [callerId, otherId].map((userId, index) => ({
        userId,
        trackId: (index === 0 ? first : second).id,
        playerName: `Player ${index}`,
        state: index === 0 ? "playing" : "paused",
        positionMs: 1_000 * (index + 1),
        playbackRate: 1 + index / 2,
        startedAt: new Date(now.getTime() - 60_000 * (index + 1)),
        reportedAt: new Date(now.getTime() - 1_000),
        expiresAt: new Date(now.getTime() + 600_000),
      })),
    );
});

describe("the Overview's joined reads, batched", () => {
  it("answer what they answer alone, for an annotated caller", async () => {
    const db = database(testEnv);
    const page = { size: 12, offset: 0 };

    const [albumRows, nowPlayingRows, scanRows] = await db.batch([
      albumsQuery(db, callerId, { type: "newest" }, page),
      nowPlayingQuery(db, callerId, now),
      scanReportQuery(db),
    ]);

    const albums = toAlbumViews(albumRows);
    const listening = toNowPlayingEntries(nowPlayingRows);

    expect(albums).toEqual(await listAlbums(db, callerId, { type: "newest" }, page));
    expect(listening).toEqual(await listNowPlaying(db, callerId, now));
    expect(toScanReport(scanRows)).toEqual(await readScanReport(db));

    // The annotation really is there, field for field, so a shifted column
    // could not pass as an all-null one.
    expect(albums.every((entry) => entry.annotation !== null)).toBe(true);
    expect(albums.some((entry) => entry.annotation?.starred)).toBe(true);
    expect(listening).toHaveLength(2);
    expect(listening.map((entry) => entry.song.annotation?.playCount)).toEqual(
      expect.arrayContaining([7, 8]),
    );
  });
});
