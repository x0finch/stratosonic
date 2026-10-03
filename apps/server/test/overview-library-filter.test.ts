import { library } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { database } from "../src/db";
import type { Env } from "../src/env";
import {
  type CookieJar,
  consoleRequest,
  cost,
  countingD1,
  GUEST_ROLE,
  seedConsoleUser,
  signIn,
} from "./console-auth-support";
import { ARCHIVE, ids, type ScopeUsers, seedTwoLibraries } from "./library-scope-support";
import { seedPlaylist, testEnv } from "./support";

/**
 * `GET /api/overview/library?library=` (#84, "Console"): the Overview of one
 * library. The counts, the genres and the newest albums are that library's,
 * with its artists counted from its albums; the playlists are everyone's;
 * and `libraries` lists what the console's switch offers.
 */

const ORIGIN = "https://overview-library-filter.stratosonic.test";
const d1 = countingD1(testEnv.DB);
const env: Env = { ...testEnv, DB: d1.binding };
const app = createApp();
const send = (request: Request) => app.request(request, undefined, env);

let owner: CookieJar;
let guest: CookieJar;
let users: ScopeUsers;

beforeAll(async () => {
  users = await seedTwoLibraries();
  await seedPlaylist({ r2Key: "playlists/Mixed.m3u", ownerId: users.adminId });
  await seedConsoleUser("Owner", "overview");
  await seedConsoleUser("Guest", "nothing", GUEST_ROLE);
  owner = (await signIn(send, ORIGIN, "owner", "overview")).jar;
  guest = (await signIn(send, ORIGIN, "guest", "nothing")).jar;
});

function overview(query: string, jar?: CookieJar) {
  return send(consoleRequest(ORIGIN, `/api/overview/library${query}`, { jar }));
}

// biome-ignore lint/suspicious/noExplicitAny: the route's JSON, read by path.
async function overviewOf(query: string): Promise<any> {
  const response = await overview(query, owner);
  expect(response.status).toBe(200);
  return response.json();
}

describe("GET /api/overview/library?library=", () => {
  it("narrows the counts, the genres and the newest albums to library 2", async () => {
    const body = await overviewOf("?library=2");

    expect(body.counts).toEqual({
      // The shared artist and the one only in library 2, from its albums.
      artists: 2,
      albums: 2,
      tracks: 2,
      genres: 2,
      durationSec: 0,
      sizeBytes: 0,
    });
    expect(body.genres).toEqual([
      { name: "Ambient", songCount: 1, albumCount: 1 },
      { name: "Rock", songCount: 1, albumCount: 1 },
    ]);
    expect(body.recentAlbums.map((album: { id: string }) => album.id).sort()).toEqual(
      [`al-${ids.secondOnly}`, `al-${ids.sharedAlbum2}`].sort(),
    );
  });

  it("keeps every playlist, and lists the libraries", async () => {
    const narrowed = await overviewOf("?library=2");
    const everything = await overviewOf("");

    expect(narrowed.playlists).toEqual(everything.playlists);
    expect(narrowed.playlists).toHaveLength(1);
    expect(narrowed.libraries).toEqual([{ id: 1, name: "Music Library" }, ARCHIVE]);
  });

  it("answers every library's totals without the parameter, as v0.5.0 did", async () => {
    const body = await overviewOf("");

    expect(body.counts).toEqual({
      artists: 3,
      albums: 4,
      tracks: 4,
      genres: 3,
      durationSec: 0,
      sizeBytes: 0,
    });
    expect(body.recentAlbums).toHaveLength(4);
  });

  it("costs one round trip, and narrows with predicates only", async () => {
    d1.reset();
    await overviewOf("?library=1");

    expect(cost(d1.statements)).toMatchObject({ statements: 5, roundTrips: 1, rowsWritten: 0 });
    expect(d1.statements.slice(0, 3).every((s) => /library_id" in \(\?\)/.test(s.sql))).toBe(true);
  });

  it.each(["?library=3", "?library=0", "?library=archive", "?library=", "?library=1e0"])(
    "answers 404 library_not_found for %s",
    async (query) => {
      const response = await overview(query, owner);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "library_not_found" });
    },
  );

  it("answers 404 for a library being removed", async () => {
    await database(testEnv).update(library).set({ state: "removing" }).where(eq(library.id, 2));
    try {
      const response = await overview("?library=2", owner);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "library_not_found" });
      expect((await overviewOf("")).libraries).toEqual([{ id: 1, name: "Music Library" }]);
    } finally {
      await database(testEnv).update(library).set({ state: "active" }).where(eq(library.id, 2));
    }
  });

  it("answers 401 without a session", async () => {
    const response = await overview("?library=2");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  it("answers 403 to a role without library:read", async () => {
    const response = await overview("?library=2", guest);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });
});
