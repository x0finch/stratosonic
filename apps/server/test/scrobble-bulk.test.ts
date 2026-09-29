import { albumId, artistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { write } from "./annotations-support";
import { bootstrapAdmin, browse } from "./browsing-support";
import { adminUserId } from "./lists-support";
import { seedAlbum, seedArtist, seedTrack } from "./support";

/**
 * A `scrobble` submission naming more tracks than one D1 statement may bind.
 *
 * This is the one caller that really does send hundreds of ids at once: a
 * client that has been offline flushes its backlog in a single request. The
 * submission path looks every id up in `findTrackParents` - one bound
 * parameter each - so the lookup is chunked, and nothing here can fail in
 * Miniflare, which is SQLite and allows 999 where D1 allows a hundred. It is
 * a guard on the chunking rather than on the platform, and it lives in its
 * own file because it seeds a library of its own.
 */

const ARTIST = "Lyra";
const ALBUM = "Longplay";
const YEAR = 2019;
const COUNT = 250;

const keys = Array.from(
  { length: COUNT },
  (_, index) => `${ARTIST}/${ALBUM}/${String(index + 1).padStart(3, "0")} Track.mp3`,
);

const theAlbumId = prefixedId("album", albumId(ARTIST, ALBUM, YEAR));
const theArtistId = prefixedId("artist", artistId(ARTIST));

beforeAll(async () => {
  await bootstrapAdmin();
  await adminUserId();

  await seedArtist({ name: ARTIST });
  await seedAlbum({ name: ALBUM, albumArtist: ARTIST, year: YEAR, songCount: COUNT });

  for (const [index, r2Key] of keys.entries()) {
    await seedTrack({
      r2Key,
      title: `Track ${index + 1}`,
      album: ALBUM,
      albumArtist: ARTIST,
      year: YEAR,
    });
  }
});

describe("submitting more ids than one statement may bind", () => {
  it("counts every play, once per track and once per album play", async () => {
    const ids = keys.map((key) => prefixedId("track", trackId(key)));

    const ok = await write("scrobble", { id: ids });
    expect(ok.status).toBe("ok");
    expect(ok.error).toBeUndefined();

    const first = (await browse("getSong", { id: ids[0] ?? "" })).song;
    expect(first?.playCount).toBe(1);

    // All 250 tracks belong to the one album, and the submission collapses
    // into a single upsert carrying all 250 of them.
    const album = (await browse("getAlbum", { id: theAlbumId })).album;
    expect(album?.playCount).toBe(COUNT);

    // The same holds for the artist: 250 tracks of one artist are one artist
    // upsert carrying all 250 plays, not 250 separate increments and not
    // doubled.
    const artist = (await browse("getArtist", { id: theArtistId })).artist;
    expect(artist?.playCount).toBe(COUNT);
  });

  it("refuses a submission naming more ids than the cap allows", async () => {
    const tooMany = Array.from({ length: 1001 }, (_, index) =>
      prefixedId("track", trackId(`${ARTIST}/${ALBUM}/never-${index}.mp3`)),
    );

    const body = await write("scrobble", { id: tooMany });
    expect(body.error?.code).toBe(0);
    expect(body.error?.message).toContain("too many ids");
  });
});
