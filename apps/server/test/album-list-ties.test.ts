import { albumId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { write } from "./annotations-support";
import { bootstrapAdmin } from "./browsing-support";
import { albumNames, list } from "./lists-support";
import { seedAlbum, seedArtist, seedTrack } from "./support";

/**
 * Paging a play-data album list whose albums tie.
 *
 * `frequent` orders by play count, which says nothing about two albums played
 * the same number of times; the album id breaks the tie, descending, as every
 * other list here breaks one. Without it SQLite is free to answer the two
 * pages in any order, and a client paging with `offset` would see an album
 * twice and another not at all.
 */

const ARTIST = "Corvus";
const YEAR = 1994;

interface AlbumFixture {
  readonly name: string;
  readonly track: string;
}

const ASTER: AlbumFixture = { name: "Aster", track: `${ARTIST}/Aster/01 A.mp3` };
const BASALT: AlbumFixture = { name: "Basalt", track: `${ARTIST}/Basalt/01 B.mp3` };

const idOf = (album: AlbumFixture) => albumId(ARTIST, album.name, YEAR);
const trackIdOf = (album: AlbumFixture) => prefixedId("track", trackId(album.track));

/** The two albums as the tie-break orders them: by album id, descending. */
const BY_ID_DESCENDING = [ASTER, BASALT]
  .sort((left, right) => (idOf(left) < idOf(right) ? 1 : -1))
  .map((album) => album.name);

const page = (offset: string) => list("getAlbumList2", { type: "frequent", size: "1", offset });

beforeAll(async () => {
  await bootstrapAdmin();
  await seedArtist({ name: ARTIST });

  for (const album of [ASTER, BASALT]) {
    await seedAlbum({ name: album.name, albumArtist: ARTIST, year: YEAR, songCount: 1 });
    await seedTrack({ r2Key: album.track, album: album.name, albumArtist: ARTIST, year: YEAR });
    // One play each, so the two albums tie on the count `frequent` sorts by.
    await write("scrobble", { id: trackIdOf(album), time: "1600000000000" });
  }
});

describe("frequent with two albums played the same number of times", () => {
  it("pages them by album id descending, without repeating either", async () => {
    const first = albumNames(await page("0"));
    const second = albumNames(await page("1"));

    expect(first).toEqual([BY_ID_DESCENDING[0]]);
    expect(second).toEqual([BY_ID_DESCENDING[1]]);
    expect(first).not.toEqual(second);
  });
});
