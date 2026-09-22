import { SELF } from "cloudflare:test";
import { artistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { write, writeQuery } from "./annotations-support";
import { type BrowsingResponse, bootstrapAdmin, browse } from "./browsing-support";
import { BASE, seedAlbum, seedArtist, seedTrack, seedUser } from "./support";

/**
 * What a `scrobble` submission leaves on the *artist* a track belongs to.
 *
 * A play counts for the artist as well as the track and the album, which is
 * what fills `getArtist`'s play data (Navidrome's `PlayTracker.incPlay`
 * increments the media file, the album and the artist). The same three things
 * hold as for the album: several tracks of one artist submitted together are
 * one artist play row carrying all of them, a late instant never drags the
 * artist's `played` backwards, and one listener's plays never touch another's.
 */

const ARTIST = "Vega";
const YEAR = 2004;

const ALBUM = "Ascend";
const FIRST = `${ARTIST}/${ALBUM}/01 First.mp3`;
const SECOND = `${ARTIST}/${ALBUM}/02 Second.mp3`;

const ARTIST_ID = prefixedId("artist", artistId(ARTIST));
const trackIdOf = (key: string) => prefixedId("track", trackId(key));

const OTHER_USER = { user: "roamer", password: "open-sesame" };

/** The artist's aggregate play data, as `getArtist` renders it for the caller. */
async function artistPlayData(credentials?: {
  user: string;
  password: string;
}): Promise<{ playCount?: number; played?: string }> {
  const artist = credentials
    ? (await browseAs(credentials)).artist
    : (await browse("getArtist", { id: ARTIST_ID })).artist;

  return { playCount: artist?.playCount, played: artist?.played };
}

/** Reads `getArtist` as another account, to prove whose annotation shows. */
async function browseAs(credentials: {
  user: string;
  password: string;
}): Promise<BrowsingResponse> {
  const query = writeQuery({ id: ARTIST_ID, f: "json" }, credentials);
  const response = await SELF.fetch(`${BASE}/rest/getArtist?${query}`);
  const body = (await response.json()) as { "subsonic-response": BrowsingResponse };

  return body["subsonic-response"];
}

beforeAll(async () => {
  await bootstrapAdmin();
  await seedUser(OTHER_USER.user, OTHER_USER.password);
  await seedArtist({ name: ARTIST });
  await seedAlbum({ name: ALBUM, albumArtist: ARTIST, year: YEAR, songCount: 2 });
  for (const key of [FIRST, SECOND]) {
    await seedTrack({ r2Key: key, album: ALBUM, albumArtist: ARTIST, year: YEAR });
  }
});

describe("two tracks of one artist in one submission", () => {
  it("counts both plays on the artist and keeps the later instant", async () => {
    await write("scrobble", {
      id: [trackIdOf(FIRST), trackIdOf(SECOND)],
      time: ["3000", "1000"],
    });

    expect(await artistPlayData()).toEqual({
      playCount: 2,
      played: new Date(3000).toISOString(),
    });
  });
});

describe("a backlogged submission", () => {
  it("counts the play without moving the artist's played backwards", async () => {
    await write("scrobble", { id: trackIdOf(FIRST), time: "2000" });

    expect(await artistPlayData()).toEqual({
      playCount: 3,
      played: new Date(3000).toISOString(),
    });
  });
});

describe("another listener's plays", () => {
  it("do not affect the caller's artist annotation", async () => {
    await write("scrobble", { id: trackIdOf(SECOND), time: "9000" }, OTHER_USER);

    // The other user's own artist annotation carries only their one play.
    expect(await artistPlayData(OTHER_USER)).toEqual({
      playCount: 1,
      played: new Date(9000).toISOString(),
    });

    // The admin's is untouched by it: still three plays, still 3000.
    expect(await artistPlayData()).toEqual({
      playCount: 3,
      played: new Date(3000).toISOString(),
    });
  });
});
