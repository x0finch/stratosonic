import { album, track } from "@stratosonic/db";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";
import { cost, countingD1 } from "./console-auth-support";
import { seedAlbum, seedTrack, testEnv } from "./support";

/**
 * `countingD1` (test/console-auth-support.ts) answers a joined select, whose
 * columns may share names, column for column, with D1's own row counts, so
 * the budget of a read that joins can be measured (#82, "Testing
 * Decisions", "Budget").
 */

beforeAll(async () => {
  await seedAlbum({ name: "Joined", albumArtist: "Counting" });
  await seedTrack({ r2Key: "Counting/Joined/One.mp3" });
  await seedTrack({ r2Key: "Counting/Joined/Two.mp3" });
});

/** Both `id`s and both name-like columns, which an object would collapse. */
function joined(db: ReturnType<typeof drizzle>) {
  return db
    .select({ trackId: track.id, title: track.title, albumId: album.id, albumName: album.name })
    .from(track)
    .innerJoin(album, eq(album.id, track.albumId))
    .orderBy(asc(track.id));
}

describe("countingD1", () => {
  it("answers a joined select as D1 does, recording one round trip and its rows", async () => {
    const d1 = countingD1(testEnv.DB);

    const counted = await joined(drizzle(d1.binding));

    expect(counted).toEqual(await joined(drizzle(testEnv.DB)));
    expect(counted).toHaveLength(2);
    expect(counted[0]?.trackId).not.toBe(counted[0]?.albumId);
    expect(cost(d1.statements)).toMatchObject({ statements: 1, roundTrips: 1, rowsWritten: 0 });
    expect(d1.statements[0]?.rowsRead).toBeGreaterThan(0);
  });

  it("refuses a joined statement that is not a select, which it would run twice", async () => {
    const d1 = countingD1(testEnv.DB);
    const statement = d1.binding.prepare(
      "delete from album where id in (select album.id from album join track on track.album_id = album.id where 0) returning id",
    );

    await expect(statement.raw()).rejects.toThrow(/joined write/);
    expect(d1.statements).toEqual([]);
  });
});
