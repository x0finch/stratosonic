import { SELF } from "cloudflare:test";
import { library, userLibrary } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { listAlbums } from "../src/library/lists";
import { librariesScope, MAX_LISTED_LIBRARIES } from "../src/library/scope";
import { searchLibrary } from "../src/library/search";
import { ADMIN, afterAuthentication, countingApp, PASSWORD } from "./library-scope-support";
import { BASE, SEED_TIME, seedAlbum, seedArtist, seedTrack, seedUser, testEnv } from "./support";

/**
 * A scope longer than `MAX_LISTED_LIBRARIES` (#84): D1 binds at most a
 * hundred parameters, and an artist read repeats its scope three times, so
 * such a scope is read through a subquery that repeats the scope rule, and
 * must keep exactly the rows the list would.
 *
 * Twenty-two active libraries and a 23rd being removed, two albums and a
 * track in each. The listener sees 21 of them; another listener is given
 * library 22 and the one being removed, so a subquery that forgot whose
 * grants it reads would let them in. The admin sees the 22 active ones,
 * through the subquery too, since a library being removed takes everyone
 * off the fast path.
 */

const { d1, call } = countingApp();
const LISTENER = "many";
const LIBRARIES = Array.from({ length: 22 }, (_, index) => index + 1);
const VISIBLE = LIBRARIES.slice(0, 21);
const REMOVING = 23;
let listenerId = "";

/** Each library's album ids, as the seeds derived them. */
const albumsOf = new Map<number, string[]>();

beforeAll(async () => {
  await SELF.fetch(`${BASE}/rest/ping`);
  const db = database(testEnv);

  for (const id of [...LIBRARIES.slice(1), REMOVING]) {
    await db.insert(library).values({
      id,
      name: `Library ${id}`,
      path: `s3://acct.r2.cloudflarestorage.com/library-${id}`,
      kind: "s3",
      state: id === REMOVING ? "removing" : "active",
      createdAt: SEED_TIME,
      updatedAt: SEED_TIME,
    });
  }

  await seedArtist({ name: "Everywhere" });
  for (const libraryId of [...LIBRARIES, REMOVING]) {
    await seedArtist({ name: `Artist ${libraryId}` });
    const common = await seedAlbum({
      libraryId,
      name: "Common",
      albumArtist: "Everywhere",
      year: 2000,
    });
    const own = await seedAlbum({
      libraryId,
      name: `Album ${libraryId}`,
      albumArtist: `Artist ${libraryId}`,
    });
    albumsOf.set(libraryId, [`al-${common.id}`, `al-${own.id}`]);
    await seedTrack({ libraryId, r2Key: `Artist ${libraryId}/Album ${libraryId}/01 Song.flac` });
  }

  listenerId = await seedUser(LISTENER, PASSWORD);
  await db
    .insert(userLibrary)
    .values(VISIBLE.slice(1).map((libraryId) => ({ userId: listenerId, libraryId })))
    .onConflictDoNothing();
  // Somebody else's grants: library 22, and the library being removed.
  const otherId = await seedUser("other", PASSWORD);
  await db.insert(userLibrary).values([
    { userId: otherId, libraryId: 22 },
    { userId: otherId, libraryId: REMOVING },
  ]);
  await call(LISTENER, "ping");
  await call(ADMIN, "ping");
});

/** The ids of an answer's entries, sorted. */
function idsOf(entries: { id: string }[] | undefined): string[] {
  return (entries ?? []).map((entry) => entry.id).sort();
}

/** The album ids of these libraries, as seeded, sorted. */
function albumsIn(libraries: readonly number[]): string[] {
  return libraries.flatMap((libraryId) => albumsOf.get(libraryId) ?? []).sort();
}

describe(`a scope of more than ${MAX_LISTED_LIBRARIES} libraries`, () => {
  it("is read through the scope rule, not listed", async () => {
    d1.reset();
    const body = await call(LISTENER, "search3", [
      ["query", ""],
      ["artistCount", "100"],
    ]);

    expect(body.status).toBe("ok");
    const statements = afterAuthentication(d1.statements);
    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      expect(statement.sql).toMatch(/exists \(select 1 from user_library ul/);
    }
  });

  it("gives the rows the listed scope gives", async () => {
    const db = database(testEnv);
    const listed = librariesScope(VISIBLE);
    const query = {
      words: [],
      artists: { count: 100, offset: 0 },
      albums: { count: 100, offset: 0 },
      songs: { count: 100, offset: 0 },
    };

    const viaRule = await call(LISTENER, "search3", [
      ["query", ""],
      ["artistCount", "100"],
      ["albumCount", "100"],
      ["songCount", "100"],
    ]);
    const viaList = await searchLibrary(db, query, listenerId, listed);
    const albums = await call(LISTENER, "getAlbumList2", [
      ["type", "alphabeticalByName"],
      ["size", "500"],
    ]);

    const ids = (entries: { id: string }[] | undefined) => (entries ?? []).map((entry) => entry.id);
    expect(ids(viaRule.searchResult3.artist)).toEqual(viaList.artists.map((a) => `ar-${a.id}`));
    expect(ids(viaRule.searchResult3.album)).toEqual(viaList.albums.map((a) => `al-${a.id}`));
    expect(ids(viaRule.searchResult3.song)).toEqual(viaList.tracks.map((t) => `tr-${t.id}`));
    expect(ids(albums.albumList2.album)).toEqual(
      (await listAlbums(db, listenerId, listed, { type: "alphabeticalByName" })).map(
        (a) => `al-${a.id}`,
      ),
    );

    // Exactly the 21 libraries granted: not library 22, which another user
    // was given, nor the one being removed. The shared artist counts 21.
    expect(idsOf(albums.albumList2.album)).toEqual(albumsIn(VISIBLE));
    expect(idsOf(viaRule.searchResult3.album)).toEqual(albumsIn(VISIBLE));
    expect(
      viaRule.searchResult3.artist.find((entry: { name: string }) => entry.name === "Everywhere")
        ?.albumCount,
    ).toBe(21);
  });

  it("is the admin's too while a library is removed, which it leaves out", async () => {
    d1.reset();
    const body = await call(ADMIN, "getAlbumList2", [
      ["type", "alphabeticalByName"],
      ["size", "500"],
    ]);

    expect(idsOf(body.albumList2.album)).toEqual(albumsIn(LIBRARIES));
    const [statement] = afterAuthentication(d1.statements);
    expect(statement?.sql).toMatch(/\(select l\.id from library l where l\.state = 'active'\)/);
    expect(statement?.sql).not.toMatch(/user_library/);

    const search = await call(ADMIN, "search3", [
      ["query", "Everywhere"],
      ["albumCount", "0"],
      ["songCount", "0"],
    ]);
    expect(search.searchResult3.artist[0]?.albumCount).toBe(LIBRARIES.length);
  });

  it("is narrowed by musicFolderId into a list", async () => {
    d1.reset();
    const body = await call(LISTENER, "getAlbumList2", [
      ["type", "newest"],
      ["musicFolderId", "3"],
      ["musicFolderId", "4"],
    ]);

    expect(idsOf(body.albumList2.album)).toEqual(albumsIn([3, 4]));
    expect(afterAuthentication(d1.statements)[0]?.sql).not.toMatch(/user_library/);
  });

  it.each([
    ["getIndexes", []],
    ["getArtists", []],
    ["getAlbumList2", [["type", "newest"]]],
    ["getStarred2", []],
    ["getRandomSongs", []],
    ["getSongsByGenre", [["genre", "Rock"]]],
    ["search2", [["query", ""]]],
    ["search3", [["query", ""]]],
  ] as const)(
    "%s answers error 0 for more than 20 distinct libraries",
    async (endpoint, params) => {
      const named = (count: number) =>
        VISIBLE.slice(0, count).map((id): [string, string] => ["musicFolderId", String(id)]);

      expect((await call(LISTENER, endpoint, [...params, ...named(21)])).error).toEqual({
        code: 0,
        message: "too many music folders: 21, at most 20 per request",
      });
      expect((await call(LISTENER, endpoint, [...params, ...named(20)])).status).toBe("ok");
    },
  );

  it("leaves search room for its words", async () => {
    const words = Array.from({ length: 40 }, (_, index) => `w${index}`).join(" ");

    const listed = await call(LISTENER, "search3", [
      ["query", words],
      ...VISIBLE.slice(0, MAX_LISTED_LIBRARIES).map((id): [string, string] => [
        "musicFolderId",
        String(id),
      ]),
    ]);

    expect(listed.status).toBe("ok");
  });
});
