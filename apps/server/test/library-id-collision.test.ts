import { playlist, playlistId, track, trackId } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import {
  runBatch as runPlaylistBatch,
  upsertPlaylistStatements,
} from "../src/playlists/repository";
import { deriveRows } from "../src/scanner/derive";
import { runBatch, upsertStatements } from "../src/scanner/repository";
import { testEnv } from "./support";

/**
 * The collision guard on the track and playlist upserts (ADR-0009, #84
 * "Entity ids"). Another library's id hashes its library id as a leading
 * part, so a library-1 key made of that part, its U+200B separator and the
 * other key hashes to the other library's id. Both upserts carry
 * `setWhere: <table>.library_id = excluded.library_id`, so such a key leaves
 * the other library's row exactly as it was instead of moving it into
 * library 1.
 */

const db = database(testEnv);
const KEY = "Aphex Twin/Selected Ambient Works 85-92/01 Xtal.mp3";
const PLAYLIST_KEY = "playlists/favourites.m3u";
const CRAFTED = (key: string) => `2​${key}`;
const AT = new Date(1_700_000_000_000);

beforeEach(async () => {
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM track"),
    testEnv.DB.prepare("DELETE FROM album"),
    testEnv.DB.prepare("DELETE FROM artist"),
    testEnv.DB.prepare("DELETE FROM playlist"),
  ]);
});

/** What the scan would write for a library-1 object at `key`. */
function scanned(key: string) {
  return deriveRows(
    { key, size: 1024, etag: "etag-crafted", uploaded: AT },
    { title: "Crafted", albumArtist: "Someone", album: "Something", duration: 1, bitRate: 128 },
    AT,
  );
}

describe("the track upsert", () => {
  it("leaves another library's track alone when a library-1 key hashes to its id", async () => {
    const theirs = {
      ...scanned(KEY).track,
      id: trackId(2, KEY),
      title: "Library 2's",
      libraryId: 2,
    };
    await db.insert(track).values(theirs);
    const before = await db.select().from(track).where(eq(track.id, theirs.id));

    const crafted = scanned(CRAFTED(KEY));
    expect(crafted.track.id).toBe(theirs.id);
    expect(crafted.track.libraryId).toBe(1);
    await runBatch(db, upsertStatements(db, crafted, AT));

    const after = await db.select().from(track);
    expect(after).toEqual(before);
    expect(after[0]).toMatchObject({ r2Key: KEY, title: "Library 2's", libraryId: 2 });
  });

  it("still updates a track of its own library", async () => {
    await runBatch(db, upsertStatements(db, scanned(KEY), AT));
    const retagged = scanned(KEY);
    await runBatch(
      db,
      upsertStatements(db, { ...retagged, track: { ...retagged.track, title: "Retagged" } }, AT),
    );

    expect(await db.select({ title: track.title, libraryId: track.libraryId }).from(track)).toEqual(
      [{ title: "Retagged", libraryId: 1 }],
    );
  });
});

describe("the playlist upsert", () => {
  const imported = (key: string, libraryId: number, name: string) => ({
    id: playlistId(libraryId, key),
    name,
    comment: "",
    ownerId: "owner",
    public: true,
    songCount: 0,
    duration: 0,
    r2Key: key,
    libraryId,
    createdAt: AT,
    changedAt: AT,
    trackIds: [],
  });

  it("leaves another library's playlist alone when a library-1 key hashes to its id", async () => {
    await runPlaylistBatch(db, upsertPlaylistStatements(db, imported(PLAYLIST_KEY, 2, "Theirs")));
    const before = await db.select().from(playlist);

    const crafted = imported(CRAFTED(PLAYLIST_KEY), 1, "Crafted");
    expect(crafted.id).toBe(playlistId(2, PLAYLIST_KEY));
    await runPlaylistBatch(db, upsertPlaylistStatements(db, crafted, { writesDetails: true }));

    const after = await db.select().from(playlist);
    expect(after).toEqual(before);
    expect(after[0]).toMatchObject({ r2Key: PLAYLIST_KEY, name: "Theirs", libraryId: 2 });
  });

  it("still updates a playlist of its own library", async () => {
    await runPlaylistBatch(db, upsertPlaylistStatements(db, imported(PLAYLIST_KEY, 1, "Before")));
    await runPlaylistBatch(db, upsertPlaylistStatements(db, imported(PLAYLIST_KEY, 1, "After")));

    expect(
      await db.select({ name: playlist.name, libraryId: playlist.libraryId }).from(playlist),
    ).toEqual([{ name: "After", libraryId: 1 }]);
  });
});
