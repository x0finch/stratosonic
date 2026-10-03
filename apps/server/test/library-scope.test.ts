import { library } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import {
  ADMIN,
  ARCHIVE,
  afterAuthentication,
  countingApp,
  ids,
  idsIn,
  inLibraries,
  LISTENER_BOTH,
  LISTENER_TWO,
  namesALibrary,
  type SubsonicJson,
  seedTwoLibraries,
} from "./library-scope-support";
import { testEnv } from "./support";

/**
 * Library access in the Subsonic API (#84, "Library access", ticket D1):
 * who sees which library, `musicFolderId` on the eight endpoints that take
 * it, and the browse, list, search, genre, starred and info reads kept to the
 * caller's libraries.
 *
 * Libraries 1 and 2 hold the same key, and one artist has an album in each.
 * The admin sees both, `two` sees library 2 only, and `both` sees both as a
 * listener: every library, so the fast path.
 */

const { d1, call } = countingApp();
const MUSIC_LIBRARY = { id: 1, name: "Music Library" };

beforeAll(async () => {
  await seedTwoLibraries();
  // Each user's first request writes `last_access_at`; spend it here, so the
  // statements a test counts are the endpoint's.
  for (const user of [ADMIN, LISTENER_TWO, LISTENER_BOTH]) {
    await call(user, "ping");
  }
});

/** The eight endpoints that take `musicFolderId`, each with what it needs. */
const MUSIC_FOLDER_ENDPOINTS: readonly (readonly [
  string,
  readonly (readonly [string, string])[],
])[] = [
  ["getIndexes", []],
  ["getArtists", []],
  [
    "getAlbumList2",
    [
      ["type", "alphabeticalByName"],
      ["size", "500"],
    ],
  ],
  ["getStarred2", []],
  ["getRandomSongs", [["size", "500"]]],
  [
    "getSongsByGenre",
    [
      ["genre", "Rock"],
      ["count", "500"],
    ],
  ],
  ["search2", [["query", ""]]],
  ["search3", [["query", ""]]],
];

describe.each(MUSIC_FOLDER_ENDPOINTS)("%s and musicFolderId", (endpoint, params) => {
  /** What the admin sees with no folder named: every library's items. */
  let everything: string[];

  beforeAll(async () => {
    const body = await call(ADMIN, endpoint, params);
    expect(body.status).toBe("ok");
    everything = idsIn(body);
    // Something in each library, or the narrowing below would prove nothing.
    expect(inLibraries(everything, [1]).length).toBeGreaterThan(0);
    expect(inLibraries(everything, [2]).length).toBeGreaterThan(0);
  });

  async function seen(user: string, extra: readonly (readonly [string, string])[] = []) {
    const body = await call(user, endpoint, [...params, ...extra]);
    expect(body.status, JSON.stringify(body.error)).toBe("ok");
    return idsIn(body);
  }

  async function refused(user: string, extra: readonly (readonly [string, string])[]) {
    const body = await call(user, endpoint, [...params, ...extra]);
    expect(body.status).toBe("failed");
    return body.error as { code: number; message: string };
  }

  it("answers the user's libraries when no folder is named", async () => {
    expect(await seen(LISTENER_TWO)).toEqual(inLibraries(everything, [2]));
    expect(await seen(LISTENER_BOTH)).toEqual(everything);
  });

  it("narrows to musicFolderId, for a listener and for the admin", async () => {
    expect(await seen(LISTENER_BOTH, [["musicFolderId", "2"]])).toEqual(
      inLibraries(everything, [2]),
    );
    expect(await seen(ADMIN, [["musicFolderId", "1"]])).toEqual(inLibraries(everything, [1]));
    expect(await seen(LISTENER_TWO, [["musicFolderId", "2"]])).toEqual(
      inLibraries(everything, [2]),
    );
  });

  it("answers error 70 for a library the user cannot see, or that does not exist", async () => {
    expect(await refused(LISTENER_TWO, [["musicFolderId", "1"]])).toEqual({
      code: 70,
      message: "Library 1 not found or not accessible",
    });
    expect(await refused(ADMIN, [["musicFolderId", "3"]])).toEqual({
      code: 70,
      message: "Library 3 not found or not accessible",
    });
  });

  it("checks every value of a repeated parameter", async () => {
    expect(
      await refused(LISTENER_TWO, [
        ["musicFolderId", "2"],
        ["musicFolderId", "1"],
      ]),
    ).toMatchObject({ code: 70, message: "Library 1 not found or not accessible" });
    expect(
      await seen(LISTENER_BOTH, [
        ["musicFolderId", "1"],
        ["musicFolderId", "2"],
      ]),
    ).toEqual(everything);
  });

  it("ignores a value that is not an integer", async () => {
    expect(await seen(LISTENER_TWO, [["musicFolderId", "archive"]])).toEqual(
      inLibraries(everything, [2]),
    );
    expect(
      await seen(LISTENER_BOTH, [
        ["musicFolderId", "1.5"],
        ["musicFolderId", "2"],
      ]),
    ).toEqual(inLibraries(everything, [2]));
  });

  it("answers error 0 for more than 20 values", async () => {
    const values = Array.from({ length: 21 }, (): [string, string] => ["musicFolderId", "2"]);

    expect(await refused(LISTENER_TWO, values)).toEqual({
      code: 0,
      message: "too many music folders: 21, at most 20 per request",
    });
    expect(await seen(LISTENER_TWO, values.slice(1))).toEqual(inLibraries(everything, [2]));
  });
});

/** The `<artist>` elements of `getArtists` or `getIndexes`, flattened. */
function artistsOf(body: SubsonicJson): SubsonicJson[] {
  const container = body.artists ?? body.indexes;
  return (container?.index ?? []).flatMap((group: SubsonicJson) => group.artist);
}

describe("an artist in two libraries", () => {
  it.each(["getArtists", "getIndexes"])(
    "is listed once by %s, with the albums and the cover in scope",
    async (endpoint) => {
      const forTwo = artistsOf(await call(LISTENER_TWO, endpoint)).filter(
        (entry) => entry.id === `ar-${ids.sharedArtist}`,
      );
      const forAdmin = artistsOf(await call(ADMIN, endpoint)).filter(
        (entry) => entry.id === `ar-${ids.sharedArtist}`,
      );
      const narrowed = artistsOf(await call(ADMIN, endpoint, [["musicFolderId", "1"]])).filter(
        (entry) => entry.id === `ar-${ids.sharedArtist}`,
      );

      expect(forTwo).toHaveLength(1);
      expect(forAdmin).toHaveLength(1);
      expect(forTwo[0]?.coverArt).toBe(`al-${ids.sharedAlbum2}`);
      expect(narrowed[0]?.coverArt).toBe(`al-${ids.sharedAlbum1}`);
      if (endpoint === "getArtists") {
        expect(forTwo[0]?.albumCount).toBe(1);
        expect(forAdmin[0]?.albumCount).toBe(2);
        expect(narrowed[0]?.albumCount).toBe(1);
      }
    },
  );

  it("shows getArtist its albums in scope, and is not found with none", async () => {
    const forTwo = await call(LISTENER_TWO, "getArtist", [["id", `ar-${ids.sharedArtist}`]]);

    expect(forTwo.artist.albumCount).toBe(1);
    expect(forTwo.artist.album.map((entry: SubsonicJson) => entry.id)).toEqual([
      `al-${ids.sharedAlbum2}`,
    ]);
    expect((await call(LISTENER_TWO, "getArtist", [["id", `ar-${ids.onlyOne}`]])).error).toEqual({
      code: 70,
      message: "Artist not found",
    });
    expect(
      (await call(LISTENER_TWO, "getAlbum", [["id", `al-${ids.sharedAlbum1}`]])).error?.code,
    ).toBe(70);
    expect(
      (await call(LISTENER_TWO, "getMusicDirectory", [["id", `ar-${ids.onlyOne}`]])).error,
    ).toEqual({ code: 70, message: "Directory not found" });
    expect((await call(ADMIN, "getArtist", [["id", `ar-${ids.onlyOne}`]])).status).toBe("ok");
  });
});

describe("the reads without musicFolderId, for the library-2 listener", () => {
  it("getTopSongs ranks only the artist's tracks in scope", async () => {
    const forTwo = await call(LISTENER_TWO, "getTopSongs", [["artist", "Shared Artist"]]);
    const forAdmin = await call(ADMIN, "getTopSongs", [["artist", "Shared Artist"]]);

    expect(idsIn(forTwo)).toEqual([`tr-${ids.sharedTrack2}`]);
    expect(idsIn(forAdmin)).toEqual([`tr-${ids.sharedTrack1}`, `tr-${ids.sharedTrack2}`].sort());
  });

  it("getGenres counts only the tracks in scope", async () => {
    const genres = (await call(LISTENER_TWO, "getGenres")).genres.genre;

    expect(genres).toEqual([
      { value: "Ambient", songCount: 1, albumCount: 1 },
      { value: "Rock", songCount: 1, albumCount: 1 },
    ]);
    expect(
      (await call(ADMIN, "getGenres")).genres.genre.find(
        (genre: SubsonicJson) => genre.value === "Rock",
      ),
    ).toEqual({ value: "Rock", songCount: 2, albumCount: 2 });
  });

  it.each(["getArtistInfo", "getArtistInfo2"])(
    "%s finds an artist only through what is in scope",
    async (endpoint) => {
      for (const id of [
        `ar-${ids.sharedArtist}`,
        `al-${ids.sharedAlbum2}`,
        `tr-${ids.calmTrack}`,
      ]) {
        expect((await call(LISTENER_TWO, endpoint, [["id", id]])).status).toBe("ok");
      }
      for (const id of [`ar-${ids.onlyOne}`, `al-${ids.sharedAlbum1}`, `tr-${ids.sharedTrack1}`]) {
        expect((await call(LISTENER_TWO, endpoint, [["id", id]])).error).toEqual({
          code: 70,
          message: "data not found",
        });
        expect((await call(ADMIN, endpoint, [["id", id]])).status).toBe("ok");
      }
    },
  );

  it.each(["getAlbumInfo", "getAlbumInfo2"])(
    "%s finds an album only in scope",
    async (endpoint) => {
      expect((await call(LISTENER_TWO, endpoint, [["id", `al-${ids.sharedAlbum2}`]])).status).toBe(
        "ok",
      );
      for (const id of [`al-${ids.sharedAlbum1}`, `tr-${ids.sharedTrack1}`]) {
        expect((await call(LISTENER_TWO, endpoint, [["id", id]])).error?.code).toBe(70);
        expect((await call(ADMIN, endpoint, [["id", id]])).status).toBe("ok");
      }
    },
  );

  it.each(["getSimilarSongs", "getSimilarSongs2"])(
    "%s draws every pool from the libraries in scope",
    async (endpoint) => {
      const container = endpoint === "getSimilarSongs" ? "similarSongs" : "similarSongs2";
      const library2 = inLibraries(
        [`tr-${ids.sharedTrack2}`, `tr-${ids.calmTrack}`, `tr-${ids.sharedTrack1}`],
        [2],
      );

      // A track (its genre and its artist's top songs), an artist (its top
      // songs and its seeds), an album (its seeds): never library 1's.
      for (const id of [
        `tr-${ids.sharedTrack2}`,
        `ar-${ids.sharedArtist}`,
        `al-${ids.sharedAlbum2}`,
      ]) {
        const body = await call(LISTENER_TWO, endpoint, [["id", id]]);
        expect(body.status).toBe("ok");
        const found = idsIn(body[container] ?? {});
        expect(found.length).toBeGreaterThan(0);
        expect(found.every((songId) => library2.includes(songId))).toBe(true);
      }
      // The admin's mix of the shared artist reaches library 1 as well.
      const forAdmin = idsIn(
        (await call(ADMIN, endpoint, [["id", `ar-${ids.sharedArtist}`]]))[container],
      );
      expect(forAdmin).toContain(`tr-${ids.sharedTrack1}`);

      for (const id of [`tr-${ids.sharedTrack1}`, `ar-${ids.onlyOne}`, `al-${ids.firstOnly}`]) {
        expect((await call(LISTENER_TWO, endpoint, [["id", id]])).error?.code).toBe(70);
      }
    },
  );
});

describe("the folders a user is told about", () => {
  it("getMusicFolders lists each user's libraries, by id", async () => {
    expect((await call(ADMIN, "getMusicFolders")).musicFolders.musicFolder).toEqual([
      MUSIC_LIBRARY,
      ARCHIVE,
    ]);
    expect((await call(LISTENER_TWO, "getMusicFolders")).musicFolders.musicFolder).toEqual([
      ARCHIVE,
    ]);
    expect((await call(LISTENER_BOTH, "getMusicFolders")).musicFolders.musicFolder).toEqual([
      MUSIC_LIBRARY,
      ARCHIVE,
    ]);
  });

  it("getUser and getUsers list the same libraries as folder ids", async () => {
    expect((await call(ADMIN, "getUser", [["username", ADMIN]])).user.folder).toEqual([1, 2]);
    expect((await call(LISTENER_TWO, "getUser", [["username", LISTENER_TWO]])).user.folder).toEqual(
      [2],
    );
    expect((await call(ADMIN, "getUsers")).users.user[0].folder).toEqual([1, 2]);
  });
});

describe("the fast path, for users who see every library", () => {
  /** What each endpoint ran in v0.5.0, besides authenticating. */
  const V050_STATEMENTS: readonly (readonly [
    string,
    readonly (readonly [string, string])[],
    number,
  ])[] = [
    ...MUSIC_FOLDER_ENDPOINTS.map(
      ([endpoint, params]) =>
        [
          endpoint,
          params,
          endpoint === "getIndexes"
            ? 2
            : endpoint.startsWith("search") || endpoint === "getStarred2"
              ? 3
              : 1,
        ] as const,
    ),
    ["getTopSongs", [["artist", "Shared Artist"]], 1],
    ["getGenres", [], 1],
    ["getMusicFolders", [], 0],
    ["getArtist", [["id", `ar-${ids.sharedArtist}`]], 2],
    ["getAlbum", [["id", `al-${ids.sharedAlbum1}`]], 2],
    ["getMusicDirectory", [["id", `ar-${ids.sharedArtist}`]], 2],
    ["getArtistInfo2", [["id", `ar-${ids.sharedArtist}`]], 1],
    ["getAlbumInfo", [["id", `al-${ids.sharedAlbum1}`]], 1],
    ["getSimilarSongs2", [["id", `ar-${ids.sharedArtist}`]], 2],
  ];

  it.each([ADMIN, LISTENER_BOTH])(
    "%s runs v0.5.0's statements, with no library predicate",
    async (user) => {
      for (const [endpoint, params, expected] of V050_STATEMENTS) {
        d1.reset();
        const body = await call(user, endpoint, params);
        expect(body.status, endpoint).toBe("ok");

        const statements = afterAuthentication(d1.statements);
        expect(statements, endpoint).toHaveLength(expected);
        expect(namesALibrary(statements), endpoint).toBe(false);
      }
    },
  );

  it("adds no round trip for a scoped user, only predicates", async () => {
    for (const [endpoint, params, expected] of V050_STATEMENTS) {
      d1.reset();
      await call(LISTENER_TWO, endpoint, params);

      const statements = afterAuthentication(d1.statements);
      expect(statements.length, endpoint).toBeLessThanOrEqual(expected);
    }
    d1.reset();
    await call(LISTENER_TWO, "getArtists");
    expect(namesALibrary(afterAuthentication(d1.statements))).toBe(true);
  });

  it("keeps the fast path when musicFolderId names every library", async () => {
    d1.reset();
    await call(ADMIN, "getAlbumList2", [
      ["type", "newest"],
      ["musicFolderId", "2"],
      ["musicFolderId", "1"],
    ]);

    expect(namesALibrary(afterAuthentication(d1.statements))).toBe(false);
  });
});

describe("a library being removed", () => {
  beforeAll(async () => {
    await database(testEnv)
      .update(library)
      .set({ state: "removing" })
      .where(eq(library.id, ARCHIVE.id));
  });

  afterAll(async () => {
    await database(testEnv)
      .update(library)
      .set({ state: "active" })
      .where(eq(library.id, ARCHIVE.id));
  });

  it("vanishes at once, for the admin too", async () => {
    expect((await call(ADMIN, "getMusicFolders")).musicFolders.musicFolder).toEqual([
      MUSIC_LIBRARY,
    ]);
    expect((await call(ADMIN, "getUser", [["username", ADMIN]])).user.folder).toEqual([1]);
    expect(idsIn(await call(ADMIN, "search3", [["query", ""]]))).toEqual(
      inLibraries(idsIn(await call(ADMIN, "search3", [["query", ""]])), [1]),
    );
    expect(idsIn(await call(ADMIN, "getAlbumList2", [["type", "newest"]]))).toEqual(
      [`al-${ids.firstOnly}`, `al-${ids.sharedAlbum1}`].sort(),
    );
    const shared = artistsOf(await call(ADMIN, "getArtists")).find(
      (entry) => entry.id === `ar-${ids.sharedArtist}`,
    );
    expect(shared?.albumCount).toBe(1);
    expect(
      artistsOf(await call(ADMIN, "getArtists")).some((entry) => entry.id === `ar-${ids.onlyTwo}`),
    ).toBe(false);
    expect(
      (
        await call(ADMIN, "getAlbumList2", [
          ["type", "newest"],
          ["musicFolderId", "2"],
        ])
      ).error,
    ).toEqual({ code: 70, message: "Library 2 not found or not accessible" });
  });

  it("leaves its only listener nothing, and nothing to name", async () => {
    expect((await call(LISTENER_TWO, "getMusicFolders")).musicFolders).toEqual({});
    expect(
      (await call(LISTENER_TWO, "getUser", [["username", LISTENER_TWO]])).user.folder,
    ).toBeUndefined();
    expect(idsIn(await call(LISTENER_TWO, "search3", [["query", ""]]))).toEqual([]);
    expect(idsIn(await call(LISTENER_TWO, "getArtists"))).toEqual([]);
  });

  it("takes the admin off the fast path while it is removed", async () => {
    d1.reset();
    await call(ADMIN, "getArtists");

    expect(namesALibrary(afterAuthentication(d1.statements))).toBe(true);
  });
});
