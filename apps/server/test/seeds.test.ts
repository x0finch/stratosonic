import { env } from "cloudflare:test";
import { album, albumId, artist, artistId, playlistTrack, track, trackId } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { fixtures } from "./fixtures/files";
import {
  seedAlbum,
  seedAnnotation,
  seedArtist,
  seedFixtureLibrary,
  seedFixtureObjects,
  seedPlaylist,
  seedTrack,
} from "./support";

/**
 * The seed helpers the endpoint and scanner tickets build their libraries
 * with. What matters is that a test can say only what it cares about and get
 * rows that hang together: ids derived the way the scanner derives them, so
 * seeded entities refer to each other without being told to.
 */

describe("seeding library rows", () => {
  it("gives an artist the id its name hashes to", async () => {
    const seeded = await seedArtist({ name: "Massive Attack" });
    const [stored] = await database(env).select().from(artist).where(eq(artist.id, seeded.id));

    expect(seeded.id).toBe(artistId("Massive Attack"));
    expect(stored).toEqual(seeded);
  });

  it("points an album at the artist of the same name, without being told", async () => {
    const artistRow = await seedArtist({ name: "Portishead" });
    const seeded = await seedAlbum({ name: "Dummy", albumArtist: "Portishead", year: 1994 });
    const [stored] = await database(env).select().from(album).where(eq(album.id, seeded.id));

    expect(seeded.artistId).toBe(artistRow.id);
    expect(seeded.id).toBe(albumId("Portishead", "Dummy", 1994));
    expect(stored).toEqual(seeded);
  });

  it("fills a track in from its R2 key when the seed says nothing else", async () => {
    const key = "Portishead/Dummy/03 Strangers.flac";
    const seeded = await seedTrack({ r2Key: key });
    const [stored] = await database(env).select().from(track).where(eq(track.id, seeded.id));

    expect(seeded).toMatchObject({
      id: trackId(key),
      title: "03 Strangers",
      albumArtist: "Portishead",
      artist: "Portishead",
      suffix: "flac",
    });
    expect(seeded.albumId).toBe(albumId("Portishead", "Dummy", null));
    expect(seeded.artistId).toBe(artistId("Portishead"));
    expect(stored).toEqual(seeded);
  });

  it("keeps what the seed does say", async () => {
    const seeded = await seedTrack({
      r2Key: "Portishead/Dummy/01 Mysterons.flac",
      title: "Mysterons",
      album: "Dummy",
      albumArtist: "Portishead",
      artist: "Portishead feat. nobody",
      trackNumber: 1,
      year: 1994,
      genre: "Trip Hop",
      duration: 305.5,
      bitRate: 900,
      size: 34_000,
    });

    expect(seeded).toMatchObject({
      title: "Mysterons",
      artist: "Portishead feat. nobody",
      albumArtist: "Portishead",
      trackNumber: 1,
      year: 1994,
      genre: "Trip Hop",
      duration: 305.5,
      bitRate: 900,
      size: 34_000,
    });
    expect(seeded.albumId).toBe(albumId("Portishead", "Dummy", 1994));
  });

  it("stores a playlist's tracks in the order they were given", async () => {
    const first = await seedTrack({ r2Key: "Seeded/Playlist/01 One.mp3" });
    const second = await seedTrack({ r2Key: "Seeded/Playlist/02 Two.mp3", duration: 2 });
    const seeded = await seedPlaylist({
      r2Key: "playlists/seeded.m3u",
      tracks: [second, first],
    });
    const entries = await database(env)
      .select()
      .from(playlistTrack)
      .where(eq(playlistTrack.playlistId, seeded.id));

    expect(seeded).toMatchObject({ name: "seeded", songCount: 2, duration: 3, public: true });
    expect(entries).toEqual([
      { playlistId: seeded.id, trackId: second.id, position: 0 },
      { playlistId: seeded.id, trackId: first.id, position: 1 },
    ]);
  });

  it("stars an item for a user by default", async () => {
    const seeded = await seedAnnotation({
      userId: "listener",
      itemId: artistId("Portishead"),
      itemType: "artist",
    });

    expect(seeded.starred).toBe(true);
    expect(seeded.starredAt).not.toBeNull();
  });
});

describe("seeding the fixtures", () => {
  // D1 is shared by the tests in a file, so the library is seeded once.
  let library: Awaited<ReturnType<typeof seedFixtureLibrary>>;

  beforeAll(async () => {
    library = await seedFixtureLibrary();
  });

  it("leaves the library a completed scan would leave", () => {
    const { artists, albums, tracks } = library;

    // Two album artists, three albums (the two M4As are on albums of their
    // own), and one track per fixture.
    expect(artists.map((row) => row.name)).toEqual(["Silent Artist", "Mute Ensemble"]);
    expect(albums.map((row) => row.name)).toEqual([
      "Quiet Album",
      "Faststart Sessions",
      "Trailing Sessions",
    ]);
    expect(tracks.map((row) => row.r2Key)).toEqual(fixtures.tracks.map((fixture) => fixture.r2Key));
  });

  it("adds each album's counts up from its own tracks", () => {
    const { albums, tracks } = library;
    const quiet = albums.find((row) => row.name === "Quiet Album");
    const ofQuiet = tracks.filter((row) => row.albumId === quiet?.id);

    expect(quiet?.songCount).toBe(2);
    expect(ofQuiet).toHaveLength(2);
    expect(quiet?.duration).toBeCloseTo(
      ofQuiet.reduce((total, row) => total + row.duration, 0),
      3,
    );
    expect(quiet?.size).toBe(ofQuiet.reduce((total, row) => total + row.size, 0));
  });

  it("keeps a track's own artist apart from its album artist", () => {
    const { tracks } = library;
    const flac = tracks.find((row) => row.suffix === "flac");

    expect(flac?.artist).toBe("Silent Artist feat. Echo");
    expect(flac?.albumArtist).toBe("Silent Artist");
    expect(flac?.artistId).toBe(artistId("Silent Artist"));
  });

  it("puts every fixture in the bucket under its own key", async () => {
    const seeded = await seedFixtureObjects();

    expect([...seeded.keys()]).toEqual([
      ...fixtures.tracks.map((fixture) => fixture.r2Key),
      fixtures.playlist.r2Key,
    ]);

    for (const [key, object] of seeded) {
      const stored = await env.MUSIC.head(key);

      expect(stored?.size, key).toBe(object.size);
      expect(stored?.etag, key).toBe(object.etag);
    }
  });

  it("puts the bytes the fixtures hold, not a stand-in", async () => {
    const seeded = await seedFixtureObjects();
    const mp3 = fixtures.tracks[0];
    const stored = await env.MUSIC.get(mp3?.r2Key as string);
    const bytes = new Uint8Array((await stored?.arrayBuffer()) ?? new ArrayBuffer(0));

    expect(seeded.get(mp3?.r2Key as string)?.size).toBe(mp3?.size);
    expect(bytes.length).toBe(mp3?.size);
    expect(String.fromCharCode(...bytes.slice(0, 3))).toBe("ID3");
  });
});
