import { albumId, artistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browse, browseXml, fixtureAlbum } from "./browsing-support";
import { fixtureTrack } from "./fixtures/files";
import { seedAlbum, seedArtist, seedFixtureLibrary, seedTrack } from "./support";

/**
 * `getAlbum`: one album with its tracks as `<song>` children, in the order
 * the record plays.
 *
 * The fixtures stand in for a scanned library — one of their albums has no
 * cover, which is how the omission rule is proved on a real row — and a
 * two-disc album is seeded beside them for the ordering.
 */

const DISC_ARTIST = "Disc Set";
const DISC_ALBUM = { name: "Two Discs", year: 2010 };

/** Seeded in an order no one would play them in. */
const DISC_TRACKS = [
  { title: "B one", discNumber: 2, trackNumber: 1 },
  { title: "A two", discNumber: 1, trackNumber: 2 },
  { title: "A one", discNumber: 1, trackNumber: 1 },
  { title: "Bonus", discNumber: null, trackNumber: null },
];

const COVERED = fixtureAlbum("Quiet Album");
const COVERLESS = fixtureAlbum("Fallback Album");

function albumUrlId(albumArtist: string, name: string, year: number | null): string {
  return prefixedId("album", albumId(albumArtist, name, year));
}

beforeAll(async () => {
  await bootstrapAdmin();
  await seedFixtureLibrary();

  await seedArtist({ name: DISC_ARTIST });
  await seedAlbum({
    name: DISC_ALBUM.name,
    albumArtist: DISC_ARTIST,
    year: DISC_ALBUM.year,
    songCount: DISC_TRACKS.length,
    duration: 4 * 120,
    coverKey: "_covers/two-discs.png",
  });

  for (const entry of DISC_TRACKS) {
    await seedTrack({
      r2Key: `${DISC_ARTIST}/${DISC_ALBUM.name}/${entry.title}.mp3`,
      title: entry.title,
      album: DISC_ALBUM.name,
      albumArtist: DISC_ARTIST,
      year: DISC_ALBUM.year,
      discNumber: entry.discNumber,
      trackNumber: entry.trackNumber,
      duration: 120,
    });
  }
});

describe("getAlbum", () => {
  it.each(["/rest/getAlbum", "/rest/getAlbum.view"])("answers on %s", async (path) => {
    const xml = await browseXml(path, {
      id: albumUrlId(DISC_ARTIST, DISC_ALBUM.name, DISC_ALBUM.year),
    });

    expect(xml).toContain('status="ok"');
    expect(xml).toContain(`<album id="al-`);
    expect(xml).toContain('<song id="tr-');
    expect(xml).toContain('isDir="false"');
  });

  it("orders the songs by disc and then track number", async () => {
    const album = (
      await browse("getAlbum", { id: albumUrlId(DISC_ARTIST, DISC_ALBUM.name, DISC_ALBUM.year) })
    ).album;

    expect(album?.song?.map((song) => song.title)).toEqual(["Bonus", "A one", "A two", "B one"]);
    expect(album?.song?.map((song) => song.discNumber)).toEqual([undefined, 1, 1, 2]);
  });

  it("reports a song count that is the number of songs it sends", async () => {
    const album = (
      await browse("getAlbum", { id: albumUrlId(DISC_ARTIST, DISC_ALBUM.name, DISC_ALBUM.year) })
    ).album;

    expect(album?.songCount).toBe(DISC_TRACKS.length);
    expect(album?.song).toHaveLength(DISC_TRACKS.length);
  });

  it("gives every song its prefixed ids and its album's cover", async () => {
    const id = albumUrlId(COVERED.albumArtist, COVERED.name, COVERED.year);
    const album = (await browse("getAlbum", { id })).album;
    const first = album?.song?.[0];

    expect(album?.coverArt).toBe(id);
    expect(first?.id).toBe(prefixedId("track", trackId(fixtureTrack("silent-track.mp3").r2Key)));
    expect(first?.parent).toBe(id);
    expect(first?.albumId).toBe(id);
    expect(first?.artistId).toBe(prefixedId("artist", artistId(COVERED.albumArtist)));
    expect(first?.coverArt).toBe(id);
    expect(first?.album).toBe(COVERED.name);
    expect(first?.type).toBe("music");
    expect(first?.isDir).toBe(false);
  });

  it("omits coverArt from the album without one, and from its songs", async () => {
    const id = albumUrlId(COVERLESS.albumArtist, COVERLESS.name, COVERLESS.year);
    const album = (await browse("getAlbum", { id })).album;

    expect(album?.name).toBe(COVERLESS.name);
    expect(album).not.toHaveProperty("coverArt");
    expect(album?.song).toHaveLength(1);
    expect(album?.song?.[0]).not.toHaveProperty("coverArt");
  });

  it("writes created with milliseconds", async () => {
    const id = albumUrlId(COVERED.albumArtist, COVERED.name, COVERED.year);
    const album = (await browse("getAlbum", { id })).album;

    expect(album?.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(album?.song?.[0]?.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("describes each song by the file it will stream", async () => {
    const id = albumUrlId(COVERED.albumArtist, COVERED.name, COVERED.year);
    const songs = (await browse("getAlbum", { id })).album?.song ?? [];
    const flac = songs.find((song) => song.suffix === "flac");
    const fixture = fixtureTrack("hushed-interlude.flac");

    expect(flac?.contentType).toBe("audio/flac");
    expect(flac?.path).toBe(fixture.r2Key);
    expect(flac?.size).toBe(fixture.size);
    expect(flac?.track).toBe(fixture.tags?.trackNumber);
    expect(flac?.genre).toBe(fixture.tags?.genre);
    expect(flac?.year).toBe(fixture.tags?.year);
  });
});
