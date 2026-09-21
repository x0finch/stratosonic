import { prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { write } from "./annotations-support";
import { bootstrapAdmin } from "./browsing-support";
import { adminUserId, list } from "./lists-support";
import { seedAlbum, seedArtist, seedTrack } from "./support";

/**
 * `star` with more ids than one D1 statement may bind.
 *
 * D1 allows a hundred bound parameters per query, so the existence check is
 * chunked; nothing here can fail in Miniflare, which is SQLite and allows
 * 999, so this is a guard on the chunking rather than on the platform. It
 * lives in its own file because it seeds, and stars, a library of its own.
 */

const ARTIST = "Carina";
const ALBUM = "Nebula";
const YEAR = 2021;
const COUNT = 250;

const keys = Array.from(
  { length: COUNT },
  (_, index) => `${ARTIST}/${ALBUM}/${String(index + 1).padStart(3, "0")} Track.mp3`,
);

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

describe("starring more ids than one statement may bind", () => {
  it("stars all of them and reads them all back", async () => {
    const ids = keys.map((key) => prefixedId("track", trackId(key)));

    const ok = await write("star", { id: ids });
    expect(ok.status).toBe("ok");
    expect(ok.error).toBeUndefined();

    const starred = (await list("getStarred2")).starred2;
    expect(starred?.song).toHaveLength(COUNT);
  });
});
