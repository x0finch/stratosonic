import { albumId, artistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browse, browseXml, fixtureAlbum } from "./browsing-support";
import { fixtureTrack } from "./fixtures/files";
import { SEED_TIME, seedFixtureLibrary } from "./support";

/**
 * `getSong`: one track, described well enough for a client to play it —
 * which is the same `<song>` element an album's children are made of.
 */

const TAGGED = fixtureTrack("silent-track.mp3");
const UNTAGGED = fixtureTrack("untagged.mp3");
const TAGGED_ALBUM = fixtureAlbum("Quiet Album");
const COVERLESS_ALBUM = fixtureAlbum("Fallback Album");

function songUrlId(r2Key: string): string {
  return prefixedId("track", trackId(r2Key));
}

beforeAll(async () => {
  await bootstrapAdmin();
  await seedFixtureLibrary();
});

describe("getSong", () => {
  it.each(["/rest/getSong", "/rest/getSong.view"])("answers on %s", async (path) => {
    const xml = await browseXml(path, { id: songUrlId(TAGGED.r2Key) });

    expect(xml).toContain('status="ok"');
    expect(xml).toContain(`<song id="${songUrlId(TAGGED.r2Key)}"`);
    expect(xml).toContain('isDir="false"');
    expect(xml).toContain('type="music"');
  });

  it("describes the track, its album and its artist", async () => {
    const song = (await browse("getSong", { id: songUrlId(TAGGED.r2Key) })).song;
    const album = albumId(TAGGED_ALBUM.albumArtist, TAGGED_ALBUM.name, TAGGED_ALBUM.year);

    expect(song).toEqual({
      id: songUrlId(TAGGED.r2Key),
      parent: prefixedId("album", album),
      isDir: false,
      title: TAGGED.tags?.title,
      album: TAGGED_ALBUM.name,
      artist: TAGGED.tags?.artist,
      track: TAGGED.tags?.trackNumber,
      year: TAGGED.tags?.year,
      genre: TAGGED.tags?.genre,
      coverArt: prefixedId("album", album),
      size: TAGGED.size,
      contentType: "audio/mpeg",
      suffix: "mp3",
      bitRate: TAGGED.bitRate.kbps,
      path: TAGGED.r2Key,
      discNumber: TAGGED.tags?.discNumber,
      created: SEED_TIME.toISOString(),
      albumId: prefixedId("album", album),
      artistId: prefixedId("artist", artistId(TAGGED_ALBUM.albumArtist)),
      type: "music",
    });
  });

  it("leaves out the duration of a track shorter than a second, as Navidrome does", async () => {
    const song = (await browse("getSong", { id: songUrlId(TAGGED.r2Key) })).song;

    expect(TAGGED.duration.seconds).toBeLessThan(1);
    expect(song).not.toHaveProperty("duration");
  });

  it("reports whole seconds for a track that has them", async () => {
    const flac = fixtureTrack("hushed-interlude.flac");
    const song = (await browse("getSong", { id: songUrlId(flac.r2Key) })).song;

    expect(song?.duration).toBe(Math.trunc(flac.duration.seconds));
  });

  it("omits coverArt when the track's album has none", async () => {
    const song = (await browse("getSong", { id: songUrlId(UNTAGGED.r2Key) })).song;

    expect(song?.album).toBe(COVERLESS_ALBUM.name);
    expect(song).not.toHaveProperty("coverArt");
  });

  it("names the track by what its R2 key implies when the tags said nothing", async () => {
    const song = (await browse("getSong", { id: songUrlId(UNTAGGED.r2Key) })).song;

    expect(song?.title).toBe(UNTAGGED.pathFallback.title);
    expect(song?.artist).toBe(UNTAGGED.pathFallback.albumArtist);
    expect(song).not.toHaveProperty("genre");
    expect(song).not.toHaveProperty("year");
  });
});
