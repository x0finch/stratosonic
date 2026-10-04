import {
  bookmark,
  nowPlaying,
  playlist,
  playQueue,
  property,
  subsonicUser,
  type Track,
} from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_JSON_BODY_BYTES } from "../src/api/json-body";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { erasePlaylistFiles } from "../src/playlists/writes";
import { bindingStorage } from "../src/storage/binding";
import { DELETE_KEYS_PER_CALL } from "../src/storage/storage";
import {
  type CookieJar,
  GUEST_ROLE,
  seedConsoleUser,
  signIn,
  subsonicPing,
} from "./console-auth-support";
import { importUntilComplete, type PlaylistsResponse, playlistObjects } from "./playlists-support";
import { expectRefusal, snapshot, subsonicUsersHarness } from "./subsonic-users-support";
import {
  BASE,
  SEED_TIME,
  seedAlbum,
  seedAnnotation,
  seedArtist,
  seedTrack,
  seedUser,
  testEnv,
} from "./support";

/**
 * `DELETE /api/subsonic-users/:id` (#82, and the owner's decision on its open
 * question 1): the user goes, with their stars, ratings, play counts, play
 * queue, bookmarks and playback session, and their playlists go too, `.m3u`
 * files and all, as Navidrome cascades a deleted user's playlists.
 *
 * Every test starts with the admin `admin` / `sesame` and the listener
 * `bob` / `builder`, each with one of every per-user row, and with playlists
 * made through `createPlaylist`, so each is a file in the bucket and a row:
 * two of Bob's and one of the admin's.
 */

const ORIGIN = "https://subsonic-users-delete.stratosonic.test";
const harness = subsonicUsersHarness(ORIGIN);
const { call, send } = harness;

let owner: CookieJar;
let guest: CookieJar;
let tracks: Track[];
let adminId: string;
let bobId: string;

beforeAll(async () => {
  await seedConsoleUser("owner", "owner-password");
  await seedConsoleUser("guest", "guest-password", GUEST_ROLE);
  owner = (await signIn(send, ORIGIN, "owner", "owner-password")).jar;
  guest = (await signIn(send, ORIGIN, "guest", "guest-password")).jar;

  await seedArtist({ name: "Artist" });
  await seedAlbum({ name: "Album", albumArtist: "Artist" });
  tracks = [];
  for (const title of ["one", "two", "three"]) {
    tracks.push(await seedTrack({ r2Key: `Artist/Album/${title}.mp3` }));
  }
});

beforeEach(async () => {
  const db = database(testEnv);
  await db.delete(subsonicUser);
  await db.delete(playlist);
  await db.delete(property);
  for (const key of (await playlistObjects()).keys()) {
    await testEnv.MUSIC.delete(key);
  }

  adminId = await seedUser("admin", "sesame", true);
  bobId = await seedUser("bob", "builder");
  for (const userId of [adminId, bobId]) {
    await seedUserRows(userId);
  }

  await createPlaylist("bob", "builder", "Bob's first", [0, 1]);
  await createPlaylist("bob", "builder", "Bob's second", [2]);
  await createPlaylist("admin", "sesame", "Admin's", [0, 2]);
});

/** One row of each kind that belongs to a user, and cascades with them. */
async function seedUserRows(userId: string): Promise<void> {
  const db = database(testEnv);
  const trackId = tracks[0]?.id ?? "";
  await seedAnnotation({ userId, itemId: trackId, itemType: "track", rating: 4, playCount: 3 });
  await db.insert(nowPlaying).values({ userId, trackId, startedAt: SEED_TIME });
  await db
    .insert(playQueue)
    .values({ userId, trackIds: JSON.stringify([trackId]), changedAt: SEED_TIME });
  await db
    .insert(bookmark)
    .values({ userId, trackId, position: 1000, createdAt: SEED_TIME, changedAt: SEED_TIME });
}

async function subsonic(
  endpoint: string,
  user: string,
  password: string,
  parameters: [string, string][] = [],
): Promise<PlaylistsResponse> {
  const query = new URLSearchParams({ u: user, p: password, v: "1.16.1", c: "test", f: "json" });
  for (const [name, value] of parameters) {
    query.append(name, value);
  }
  const response = await send(new Request(`${BASE}/rest/${endpoint}?${query}`));
  return ((await response.json()) as { "subsonic-response": PlaylistsResponse })[
    "subsonic-response"
  ];
}

async function createPlaylist(user: string, password: string, name: string, entries: number[]) {
  const response = await subsonic("createPlaylist", user, password, [
    ["name", name],
    ...entries.map((index): [string, string] => ["songId", `tr-${tracks[index]?.id}`]),
  ]);
  expect(response.error).toBeUndefined();
}

/** The playlists the admin sees through `getPlaylists`, by name, with their owner. */
async function adminsView(): Promise<{ name: string; owner?: string }[]> {
  const response = await subsonic("getPlaylists", "admin", "sesame");
  return (response.playlists?.playlist ?? []).map(({ name, owner }) => ({ name, owner }));
}

async function rowsOf(userId: string) {
  const all = await snapshot();
  const playlistIds = new Set(
    all.playlists.filter((row) => row.ownerId === userId).map((row) => row.id),
  );
  return {
    users: all.users.filter((row) => row.id === userId),
    playlists: all.playlists.filter((row) => row.ownerId === userId),
    entries: all.entries.filter((row) => playlistIds.has(row.playlistId)),
    annotations: all.annotations.filter((row) => row.userId === userId),
    nowPlaying: all.nowPlaying.filter((row) => row.userId === userId),
    playQueues: all.playQueues.filter((row) => row.userId === userId),
    bookmarks: all.bookmarks.filter((row) => row.userId === userId),
  };
}

/** The `.m3u` keys of a user's playlists, from their rows. */
async function keysOf(userId: string): Promise<string[]> {
  return (await rowsOf(userId)).playlists.map((row) => row.r2Key).sort();
}

function deleteUser(id: string, jar: CookieJar | undefined = owner) {
  return call(jar, "DELETE", `/subsonic-users/${id}`, {});
}

/** A playlist import that begins after everything R2 has stamped. */
function importLater() {
  return importUntilComplete({}, new Date(Date.now() + 10 * 60_000));
}

describe("DELETE /api/subsonic-users/:id", () => {
  it("deletes the user, what belongs to them, and their playlists' files and rows", async () => {
    const bobKeys = await keysOf(bobId);
    const adminRows = await rowsOf(adminId);
    const adminKeys = await keysOf(adminId);
    expect(bobKeys).toHaveLength(2);
    expect((await rowsOf(bobId)).entries).toHaveLength(3);

    const response = await deleteUser(bobId);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({ ok: true });

    // One R2 call for every file, and only Bob's.
    expect(harness.r2Deletes.slice(-1).map((keys) => [keys].flat().sort())).toEqual([bobKeys]);
    expect([...(await playlistObjects()).keys()].sort()).toEqual(adminKeys);

    // Bob and everything of his are gone; the admin's rows are as they were.
    expect(await rowsOf(bobId)).toEqual({
      users: [],
      playlists: [],
      entries: [],
      annotations: [],
      nowPlaying: [],
      playQueues: [],
      bookmarks: [],
    });
    expect(await rowsOf(adminId)).toEqual(adminRows);

    expect(await subsonicPing(send, ORIGIN, "bob", "builder")).toBe(40);
    expect(await adminsView()).toEqual([{ name: "Admin's", owner: "admin" }]);
  });

  it("is not undone by the next playlist import", async () => {
    await deleteUser(bobId);
    const after = await snapshot();

    await importLater();

    expect(await adminsView()).toEqual([{ name: "Admin's", owner: "admin" }]);
    expect((await snapshot()).playlists).toEqual(after.playlists);
  });

  it("makes no R2 call for a user without playlists", async () => {
    const carolId = await seedUser("carol", "singer");
    const calls = harness.r2Deletes.length;

    expect((await deleteUser(carolId)).status).toBe(200);

    expect(harness.r2Deletes.length).toBe(calls);
    expect((await snapshot()).users.map((row) => row.id).sort()).toEqual([adminId, bobId].sort());
  });

  it("refuses to delete the only admin, touching no file", async () => {
    const files = await playlistObjects();

    await expectRefusal(harness, () => deleteUser(adminId), 409, "last_admin");

    expect(await playlistObjects()).toEqual(files);
  });

  it("deletes one of two admins, and then not the other", async () => {
    const daveId = await seedUser("dave", "diver", true);

    expect((await deleteUser(daveId)).status).toBe(200);
    await expectRefusal(harness, () => deleteUser(adminId), 409, "last_admin");
  });

  it("refuses an unknown id, touching no file", async () => {
    await expectRefusal(harness, () => deleteUser("nobody"), 404, "not_found");
  });

  it("removes the erased files' rows when the guard refuses after the files went", async () => {
    // Bob is one of two admins when the check runs; the other is demoted by a
    // racing request once Bob's files are gone, so the guarded batch refuses.
    await database(testEnv)
      .update(subsonicUser)
      .set({ isAdmin: true })
      .where(eq(subsonicUser.id, bobId));
    const bobKeys = await keysOf(bobId);
    const before = await rowsOf(bobId);
    const adminRows = await rowsOf(adminId);
    harness.afterNextR2Delete(() =>
      database(testEnv)
        .update(subsonicUser)
        .set({ isAdmin: false })
        .where(eq(subsonicUser.id, adminId)),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    let response: Response;
    let warnings: unknown[][];
    try {
      response = await deleteUser(bobId);
    } finally {
      warnings = [...warn.mock.calls];
      warn.mockRestore();
    }

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "last_admin" });
    // Bob stays, with everything but the playlists whose files went; D1
    // agrees with the bucket at once rather than at the next sweep.
    expect(harness.r2Deletes.at(-1)).toEqual(expect.arrayContaining(bobKeys));
    const files = [...(await playlistObjects()).keys()];
    expect(files.filter((key) => bobKeys.includes(key))).toEqual([]);
    expect(await rowsOf(bobId)).toEqual({ ...before, playlists: [], entries: [] });
    expect(await rowsOf(adminId)).toEqual({
      ...adminRows,
      users: adminRows.users.map((row) => ({ ...row, isAdmin: false })),
    });
    // Logged by id and count, never by name.
    expect(warnings).toHaveLength(1);
    const [message] = warnings[0] ?? [];
    expect(message).toContain(bobId);
    expect(message).toContain(`${bobKeys.length} playlist files`);
    expect(String(message).replace(bobId, "")).not.toContain("bob");
  });

  it("answers 500 when R2 fails, leaving the user and every row in place", async () => {
    const before = await snapshot();
    const files = await playlistObjects();
    harness.failNextR2Delete();

    const response = await deleteUser(bobId);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expect(await snapshot()).toEqual(before);
    expect(await playlistObjects()).toEqual(files);
    expect(await subsonicPing(send, ORIGIN, "bob", "builder")).toBe("ok");

    // The same delete, tried again, goes through.
    expect((await deleteUser(bobId)).status).toBe(200);
    expect(await rowsOf(bobId)).toMatchObject({ users: [], playlists: [] });
  });

  it("leaves rows the next import removes when D1 fails after the files went", async () => {
    const before = await snapshot();
    const adminKeys = await keysOf(adminId);
    harness.failNextUserDeleteBatch();

    const response = await deleteUser(bobId);

    // The files are gone and the rows not yet: the user is still there.
    expect(response.status).toBe(500);
    expect(await snapshot()).toEqual(before);
    expect([...(await playlistObjects()).keys()].sort()).toEqual(adminKeys);

    // The next import removes the rows whose file is gone, and brings back
    // nothing.
    await importLater();
    expect(await rowsOf(bobId)).toMatchObject({ playlists: [], entries: [] });
    expect(await adminsView()).toEqual([{ name: "Admin's", owner: "admin" }]);

    // Deleting the user again finishes the job, with no file left to delete.
    const calls = harness.r2Deletes.length;
    expect((await deleteUser(bobId)).status).toBe(200);
    expect(harness.r2Deletes.length).toBe(calls);
    expect((await rowsOf(bobId)).users).toEqual([]);
  });

  it("refuses a request without a session", async () => {
    await expectRefusal(
      harness,
      () => call(undefined, "DELETE", `/subsonic-users/${bobId}`, {}),
      401,
      "unauthenticated",
    );
  });

  it("refuses a console user whose role lacks subsonic-users:write", async () => {
    await expectRefusal(harness, () => deleteUser(bobId, guest), 403, "forbidden");
  });

  it("refuses a cross-origin request", async () => {
    await expectRefusal(
      harness,
      () =>
        call(owner, "DELETE", `/subsonic-users/${bobId}`, {}, { origin: "https://evil.example" }),
      403,
      "forbidden_origin",
    );
  });

  it("refuses a request that is not JSON", async () => {
    await expectRefusal(
      harness,
      () => call(owner, "DELETE", `/subsonic-users/${bobId}`, {}, { "content-type": "text/plain" }),
      403,
      "forbidden_origin",
    );
  });

  it("refuses a body over the cap", async () => {
    await expectRefusal(
      harness,
      () =>
        call(owner, "DELETE", `/subsonic-users/${bobId}`, {
          padding: "x".repeat(MAX_JSON_BODY_BYTES),
        }),
      413,
      "payload_too_large",
    );
  });

  it("refuses a body that is not a JSON object", async () => {
    await expectRefusal(
      harness,
      () => call(owner, "DELETE", `/subsonic-users/${bobId}`, []),
      400,
      "invalid_request",
    );
  });
});

describe("erasePlaylistFiles", () => {
  /** A bucket that only records what it is asked to delete. */
  function recordingBucket() {
    const calls: string[][] = [];
    const env = {
      ...testEnv,
      MUSIC: {
        delete: async (keys: string[]) => {
          calls.push(keys);
        },
      },
    } as unknown as Env;
    return { env, calls };
  }

  it(`deletes at most ${DELETE_KEYS_PER_CALL} keys per R2 call`, async () => {
    const keys = Array.from(
      { length: DELETE_KEYS_PER_CALL + 1 },
      (_, index) => `playlists/${index}.m3u`,
    );
    const { env, calls } = recordingBucket();

    await erasePlaylistFiles(bindingStorage(env), keys);

    expect(calls.map((call) => call.length)).toEqual([DELETE_KEYS_PER_CALL, 1]);
    expect(calls.flat()).toEqual(keys);
  });

  it("makes no call for no key", async () => {
    const { env, calls } = recordingBucket();

    await erasePlaylistFiles(bindingStorage(env), []);

    expect(calls).toEqual([]);
  });
});
