import { SELF } from "cloudflare:test";
import { albumId, artistId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { cost } from "./console-auth-support";
import {
  ADMIN,
  afterAuthentication,
  countingApp,
  namesALibrary,
  PASSWORD,
} from "./library-scope-support";
import { BASE, seedAlbum, seedArtist, seedTrack, seedUser, testEnv } from "./support";

/**
 * The fast path on a one-library server (#84, "Who sees what"): every user,
 * the admin and a listener alike, sees every library, so no read adds a
 * library predicate and every endpoint runs the statements v0.5.0 ran. The
 * user's libraries are read in the statement that authenticates them, which
 * is the one cost the upgrade adds: rows, not round trips.
 */

const { d1, call, fetch } = countingApp();
const LISTENER = "listener";

beforeAll(async () => {
  // The bootstrap admin, made by the Worker's first request.
  await SELF.fetch(`${BASE}/rest/ping`);
  await call(ADMIN, "ping");
  await seedUser(LISTENER, PASSWORD);
  await call(LISTENER, "ping");

  await seedArtist({ name: "Solo" });
  await seedAlbum({
    name: "Debut",
    albumArtist: "Solo",
    year: 2000,
    genre: "Pop",
    songCount: 2,
    coverKey: COVER,
  });
  await seedTrack({ r2Key: "Solo/Debut/01 One.flac", year: 2000, genre: "Pop" });
  await seedTrack({ r2Key: "Solo/Debut/02 Two.flac", year: 2000, genre: "Pop" });
  await testEnv.MUSIC.put("Solo/Debut/01 One.flac", new TextEncoder().encode("one"));
  await testEnv.MUSIC.put(COVER, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
});

const ARTIST = `ar-${artistId("Solo")}`;
const ALBUM = `al-${albumId(1, "Solo", "Debut", 2000)}`;
const ONE = `tr-${trackId(1, "Solo/Debut/01 One.flac")}`;
const TWO = `tr-${trackId(1, "Solo/Debut/02 Two.flac")}`;
const COVER = "_covers/debut.jpg";

/** Each endpoint, what it is asked, and the statements v0.5.0 ran besides authenticating. */
const V050: readonly (readonly [string, readonly (readonly [string, string])[], number])[] = [
  ["getIndexes", [], 2],
  ["getArtists", [], 1],
  ["getAlbumList2", [["type", "newest"]], 1],
  ["getStarred2", [], 3],
  ["getRandomSongs", [], 1],
  ["getSongsByGenre", [["genre", "Pop"]], 1],
  ["search2", [["query", "solo"]], 3],
  ["search3", [["query", "solo"]], 3],
  ["getTopSongs", [["artist", "Solo"]], 1],
  ["getGenres", [], 1],
  ["getMusicFolders", [], 0],
  ["getUser", [["username", ADMIN]], 0],
  ["getArtist", [["id", ARTIST]], 2],
  ["getAlbum", [["id", ALBUM]], 2],
  ["getMusicDirectory", [["id", ALBUM]], 2],
  ["getArtistInfo", [["id", ARTIST]], 1],
  ["getAlbumInfo2", [["id", ALBUM]], 1],
  ["getSimilarSongs", [["id", ALBUM]], 2],
  // The id endpoints and the saved state (#148).
  ["getSong", [["id", ONE]], 1],
  ["getLyricsBySongId", [["id", ONE]], 1],
  [
    "getLyrics",
    [
      ["artist", "Solo"],
      ["title", "01 One"],
    ],
    1,
  ],
  ["star", [["id", ONE]], 2],
  ["unstar", [["albumId", ALBUM]], 2],
  [
    "setRating",
    [
      ["id", ARTIST],
      ["rating", "4"],
    ],
    2,
  ],
  ["scrobble", [["id", ONE]], 4],
  [
    "scrobble",
    [
      ["id", ONE],
      ["submission", "false"],
    ],
    2,
  ],
  [
    "reportPlayback",
    [
      ["mediaId", TWO],
      ["mediaType", "song"],
      ["positionMs", "0"],
      ["state", "playing"],
    ],
    2,
  ],
  ["getNowPlaying", [], 1],
  [
    "createBookmark",
    [
      ["id", ONE],
      ["position", "5"],
    ],
    2,
  ],
  ["getBookmarks", [], 1],
  [
    "savePlayQueue",
    [
      ["id", ONE],
      ["id", TWO],
      ["current", TWO],
    ],
    1,
  ],
  ["getPlayQueue", [], 2],
  ["getPlaylists", [], 1],
];

/** The endpoints that answer with bytes, each with what v0.5.0 ran besides authenticating. */
const V050_BYTES: readonly (readonly [string, string, number])[] = [
  ["stream", ONE, 1],
  ["download", ONE, 1],
  ["getCoverArt", ALBUM, 1],
  ["getCoverArt", ONE, 1],
  ["getCoverArt", ARTIST, 2],
];

/**
 * Whether any of these statements joins the library table: a read of the
 * bytes that needs the track's library row (storage/track-storage.ts), which
 * a one-library server never needs.
 */
function joinsALibrary(statements: readonly { sql: string }[]): boolean {
  return statements.some((statement) => /\bjoin "library"/.test(statement.sql));
}

describe("the fast path on a one-library server", () => {
  it.each([ADMIN, LISTENER])(
    "%s runs v0.5.0's statements, with no library predicate",
    async (user) => {
      for (const [endpoint, params, expected] of V050) {
        const asked = endpoint === "getUser" ? [["username", user] as const] : params;
        d1.reset();
        const body = await call(user, endpoint, asked);
        expect(body.status, endpoint).toBe("ok");

        const statements = afterAuthentication(d1.statements);
        expect(statements, endpoint).toHaveLength(expected);
        expect(namesALibrary(statements), endpoint).toBe(false);
        expect(joinsALibrary(statements), endpoint).toBe(false);
      }
    },
  );

  it.each([ADMIN, LISTENER])(
    "%s streams and fetches covers with v0.5.0's statements, and no library row",
    async (user) => {
      for (const [endpoint, id, expected] of V050_BYTES) {
        d1.reset();
        const response = await fetch(user, endpoint, [["id", id]]);
        expect(response.status, `${endpoint} ${id}`).toBe(200);
        await response.arrayBuffer();

        const statements = afterAuthentication(d1.statements);
        expect(statements, `${endpoint} ${id}`).toHaveLength(expected);
        expect(namesALibrary(statements), endpoint).toBe(false);
        expect(joinsALibrary(statements), endpoint).toBe(false);
      }
    },
  );

  it.each([ADMIN, LISTENER])(
    "%s writes and reads a playlist with v0.5.0's statements",
    async (user) => {
      d1.reset();
      const created = await call(user, "createPlaylist", [
        ["name", `Mix of ${user}`],
        ["songId", ONE],
      ]);
      expect(created.status).toBe("ok");
      const createdBy = afterAuthentication(d1.statements);
      const id = created.playlist.id as string;

      d1.reset();
      expect((await call(user, "getPlaylist", [["id", id]])).playlist.songCount).toBe(1);
      const readBy = afterAuthentication(d1.statements);

      d1.reset();
      const updated = await call(user, "updatePlaylist", [
        ["playlistId", id],
        ["songIdToAdd", TWO],
        ["songIndexToRemove", "0"],
      ]);
      expect(updated.status).toBe("ok");
      const updatedBy = afterAuthentication(d1.statements);

      expect([createdBy.length, readBy.length, updatedBy.length]).toEqual([6, 2, 6]);
      for (const statements of [createdBy, readBy, updatedBy]) {
        expect(namesALibrary(statements)).toBe(false);
        expect(joinsALibrary(statements)).toBe(false);
      }
    },
  );

  it("keeps it with musicFolderId=1", async () => {
    for (const user of [ADMIN, LISTENER]) {
      d1.reset();
      const body = await call(user, "getAlbumList2", [
        ["type", "newest"],
        ["musicFolderId", "1"],
      ]);

      expect(body.albumList2.album).toHaveLength(1);
      expect(namesALibrary(afterAuthentication(d1.statements))).toBe(false);
    }
  });

  it("reads the user's libraries in the one authenticating statement", async () => {
    for (const user of [ADMIN, LISTENER]) {
      d1.reset();
      await call(user, "ping");

      // One statement, one round trip, no write, as v0.5.0's lookup: its one
      // row (the user), plus library 1 for the list and for the count, and
      // for a listener their one grant (#84's "+libraries +own user_library
      // rows").
      expect(cost(d1.statements)).toEqual({
        statements: 1,
        roundTrips: 1,
        rowsRead: user === ADMIN ? 3 : 4,
        rowsWritten: 0,
      });
    }
  });
});

describe("a listener given no library", () => {
  const NOBODY = "nobody";

  beforeAll(async () => {
    const id = await seedUser(NOBODY, PASSWORD);
    await testEnv.DB.prepare("delete from user_library where user_id = ?").bind(id).run();
    await call(NOBODY, "ping");
  });

  it("sees no folder and nothing in it, and an empty answer rather than an error", async () => {
    expect((await call(NOBODY, "getMusicFolders")).musicFolders).toEqual({});
    expect((await call(NOBODY, "getArtists")).artists).toEqual({
      ignoredArticles: expect.any(String),
    });
    expect((await call(NOBODY, "getAlbumList2", [["type", "newest"]])).albumList2).toEqual({});
    expect((await call(NOBODY, "getGenres")).genres).toEqual({});
    expect((await call(NOBODY, "getArtists", [["musicFolderId", "1"]])).error).toEqual({
      code: 70,
      message: "Library 1 not found or not accessible",
    });
  });
});
