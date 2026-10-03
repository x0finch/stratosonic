import { SELF } from "cloudflare:test";
import { albumId, library, userLibrary } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { listAlbums } from "../src/library/lists";
import { librariesScope, MAX_LISTED_LIBRARIES } from "../src/library/scope";
import { searchLibrary } from "../src/library/search";
import { afterAuthentication, countingApp, PASSWORD } from "./library-scope-support";
import { BASE, SEED_TIME, seedAlbum, seedArtist, seedTrack, seedUser, testEnv } from "./support";

/**
 * A scope longer than `MAX_LISTED_LIBRARIES` (#84): D1 binds at most a
 * hundred parameters, and an artist read repeats its scope three times, so
 * such a scope is read through a subquery that repeats the scope rule, and
 * must keep exactly the rows the list would.
 *
 * Twenty-two libraries, an album and a track in each; the listener sees 21.
 */

const { d1, call } = countingApp();
const LISTENER = "many";
const LIBRARIES = Array.from({ length: 22 }, (_, index) => index + 1);
const VISIBLE = LIBRARIES.slice(0, 21);
let listenerId = "";

beforeAll(async () => {
  await SELF.fetch(`${BASE}/rest/ping`);
  const db = database(testEnv);

  for (const id of LIBRARIES.slice(1)) {
    await db.insert(library).values({
      id,
      name: `Library ${id}`,
      path: `s3://acct.r2.cloudflarestorage.com/library-${id}`,
      kind: "s3",
      createdAt: SEED_TIME,
      updatedAt: SEED_TIME,
    });
  }

  await seedArtist({ name: "Everywhere" });
  for (const libraryId of LIBRARIES) {
    await seedArtist({ name: `Artist ${libraryId}` });
    await seedAlbum({ libraryId, name: "Common", albumArtist: "Everywhere", year: 2000 });
    await seedAlbum({ libraryId, name: `Album ${libraryId}`, albumArtist: `Artist ${libraryId}` });
    await seedTrack({ libraryId, r2Key: `Artist ${libraryId}/Album ${libraryId}/01 Song.flac` });
  }

  listenerId = await seedUser(LISTENER, PASSWORD);
  await db
    .insert(userLibrary)
    .values(VISIBLE.slice(1).map((libraryId) => ({ userId: listenerId, libraryId })))
    .onConflictDoNothing();
  await call(LISTENER, "ping");
});

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

    // Library 22 is the one left out, and the shared artist counts 21 albums.
    expect(viaList.albums).toHaveLength(42);
    expect(ids(viaRule.searchResult3.album)).not.toContain(
      `al-${albumId(22, "Artist 22", "Album 22", null)}`,
    );
    expect(
      viaRule.searchResult3.artist.find((entry: { name: string }) => entry.name === "Everywhere")
        ?.albumCount,
    ).toBe(21);
  });

  it("is narrowed by musicFolderId into a list", async () => {
    d1.reset();
    const body = await call(LISTENER, "getAlbumList2", [
      ["type", "newest"],
      ["musicFolderId", "3"],
      ["musicFolderId", "4"],
    ]);

    expect(body.albumList2.album).toHaveLength(4);
    expect(afterAuthentication(d1.statements)[0]?.sql).not.toMatch(/user_library/);
  });

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
