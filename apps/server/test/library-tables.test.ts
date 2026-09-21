import { env } from "cloudflare:test";
import { album, annotation, artist, playlist, playlistTrack, track } from "@stratosonic/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { database } from "../src/db";

/**
 * The library tables as the migration creates them: what a row round-trips as,
 * and the three uniqueness rules the scanner and the importer rely on.
 */

const CREATED = new Date(1_700_000_000_000);
const UPDATED = new Date(1_700_000_001_000);

describe("the library tables", () => {
  it("round-trips an artist", async () => {
    const db = database(env);
    const row = {
      id: "artist-round-trip",
      name: "Silent Artist",
      sortName: "silent artist",
      createdAt: CREATED,
      updatedAt: UPDATED,
    };

    await db.insert(artist).values(row);
    const [stored] = await db.select().from(artist).where(eq(artist.id, row.id));

    expect(stored).toEqual(row);
  });

  it("round-trips an album, keeping a fractional duration", async () => {
    const db = database(env);
    const row = {
      id: "album-round-trip",
      name: "Quiet Album",
      artistId: "artist-round-trip",
      albumArtist: "Silent Artist",
      year: 2001,
      genre: "Electronic",
      songCount: 2,
      duration: 123.45,
      size: 4096,
      coverKey: "_covers/album-round-trip.png",
      createdAt: CREATED,
      updatedAt: UPDATED,
    };

    await db.insert(album).values(row);
    const [stored] = await db.select().from(album).where(eq(album.id, row.id));

    expect(stored).toEqual(row);
  });

  it("leaves an album's optional columns null and its counts zero", async () => {
    const db = database(env);

    await db.insert(album).values({
      id: "album-defaults",
      name: "Untagged",
      artistId: "artist-round-trip",
      albumArtist: "Silent Artist",
      createdAt: CREATED,
      updatedAt: UPDATED,
    });
    const [stored] = await db.select().from(album).where(eq(album.id, "album-defaults"));

    expect(stored).toMatchObject({
      year: null,
      genre: null,
      coverKey: null,
      songCount: 0,
      duration: 0,
      size: 0,
    });
  });

  it("round-trips a track", async () => {
    const db = database(env);
    const row = {
      id: "track-round-trip",
      r2Key: "Silent Artist/Quiet Album/01 Silent Track.mp3",
      title: "Silent Track",
      albumId: "album-round-trip",
      artistId: "artist-round-trip",
      artist: "Silent Artist",
      albumArtist: "Silent Artist",
      trackNumber: 3,
      discNumber: 1,
      year: 2001,
      duration: 61.5,
      bitRate: 128,
      size: 984_060,
      suffix: "mp3",
      genre: "Electronic",
      etag: "abc123",
      createdAt: CREATED,
      updatedAt: UPDATED,
    };

    await db.insert(track).values(row);
    const [stored] = await db.select().from(track).where(eq(track.id, row.id));

    expect(stored).toEqual(row);
  });

  it("refuses a second track with the same R2 key", async () => {
    const db = database(env);
    const row = {
      id: "track-duplicate-key",
      r2Key: "Silent Artist/Quiet Album/02 Hushed Interlude.flac",
      title: "Hushed Interlude",
      albumId: "album-round-trip",
      artistId: "artist-round-trip",
      artist: "Silent Artist",
      albumArtist: "Silent Artist",
      suffix: "flac",
      createdAt: CREATED,
      updatedAt: UPDATED,
    };

    await db.insert(track).values(row);

    await expect(
      db.insert(track).values({ ...row, id: "track-duplicate-key-again" }),
    ).rejects.toThrow();
  });

  it("round-trips a playlist", async () => {
    const db = database(env);
    const row = {
      id: "playlist-round-trip",
      name: "favourites",
      comment: "",
      ownerId: "owner",
      public: true,
      songCount: 1,
      duration: 61.5,
      r2Key: "playlists/favourites.m3u",
      createdAt: CREATED,
      changedAt: UPDATED,
    };

    await db.insert(playlist).values(row);
    const [stored] = await db.select().from(playlist).where(eq(playlist.id, row.id));

    expect(stored).toEqual(row);
  });

  it("round-trips a playlist entry and allows the same track twice", async () => {
    const db = database(env);

    await db.insert(playlistTrack).values([
      { playlistId: "playlist-round-trip", trackId: "track-round-trip", position: 0 },
      { playlistId: "playlist-round-trip", trackId: "track-round-trip", position: 1 },
    ]);
    const stored = await db
      .select()
      .from(playlistTrack)
      .where(eq(playlistTrack.playlistId, "playlist-round-trip"));

    expect(stored).toEqual([
      { playlistId: "playlist-round-trip", trackId: "track-round-trip", position: 0 },
      { playlistId: "playlist-round-trip", trackId: "track-round-trip", position: 1 },
    ]);
  });

  it("refuses two entries at the same position in one playlist", async () => {
    const db = database(env);

    await db
      .insert(playlistTrack)
      .values({ playlistId: "playlist-positions", trackId: "track-round-trip", position: 0 });

    await expect(
      db
        .insert(playlistTrack)
        .values({ playlistId: "playlist-positions", trackId: "track-duplicate-key", position: 0 }),
    ).rejects.toThrow();
  });

  it("round-trips an annotation", async () => {
    const db = database(env);
    const row = {
      userId: "listener",
      itemId: "track-round-trip",
      itemType: "track" as const,
      starred: true,
      starredAt: UPDATED,
      rating: 4,
      playCount: 7,
      playDate: UPDATED,
    };

    await db.insert(annotation).values(row);
    const [stored] = await db
      .select()
      .from(annotation)
      .where(
        and(
          eq(annotation.userId, row.userId),
          eq(annotation.itemId, row.itemId),
          eq(annotation.itemType, row.itemType),
        ),
      );

    expect(stored).toEqual(row);
  });

  it("starts an annotation unstarred, unrated and unplayed", async () => {
    const db = database(env);

    await db
      .insert(annotation)
      .values({ userId: "listener", itemId: "album-round-trip", itemType: "album" });
    const [stored] = await db
      .select()
      .from(annotation)
      .where(eq(annotation.itemId, "album-round-trip"));

    expect(stored).toMatchObject({
      starred: false,
      starredAt: null,
      rating: 0,
      playCount: 0,
      playDate: null,
    });
  });

  it("keeps one annotation per user, item and item type", async () => {
    const db = database(env);
    const row = { userId: "listener", itemId: "shared-id", itemType: "artist" as const };

    await db.insert(annotation).values(row);
    // The same item id under another type is a different item, and so is the
    // same item for another user.
    await db.insert(annotation).values({ ...row, itemType: "playlist" });
    await db.insert(annotation).values({ ...row, userId: "other-listener" });

    await expect(db.insert(annotation).values({ ...row, rating: 5 })).rejects.toThrow();
  });
});
