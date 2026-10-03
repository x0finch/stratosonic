import { album, artist, playlist, prefixedId, track } from "@stratosonic/db";
import { count, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { bootstrapAdmin, browse } from "./browsing-support";
import {
  type CookieJar,
  consoleRequest,
  cost,
  countingD1,
  GUEST_ROLE,
  seedConsoleUser,
  shape,
  signIn,
} from "./console-auth-support";
import { adminUserId, list } from "./lists-support";
import {
  SEED_TIME,
  seedAlbum,
  seedArtist,
  seedFixtureLibrary,
  seedPlaylist,
  testEnv,
} from "./support";

/**
 * `GET /api/overview/library` (#82, "API: overview"): the library's counts,
 * its genres, its newest albums and every playlist, for the console's
 * Overview, in one D1 round trip.
 *
 * What it answers is checked against the tables and against the Subsonic
 * endpoints that answer the same questions, `getGenres` and
 * `getAlbumList2?type=newest`, which it must agree with.
 */

const ORIGIN = "https://overview-library.stratosonic.test";
const d1 = countingD1(testEnv.DB);
const env: Env = { ...testEnv, DB: d1.binding };
const app = createApp();
const send = (request: Request) => app.request(request, undefined, env);

interface LibraryOverview {
  counts: {
    artists: number;
    albums: number;
    tracks: number;
    genres: number;
    durationSec: number;
    sizeBytes: number;
  };
  genres: { name: string; songCount: number; albumCount: number }[];
  recentAlbums: {
    id: string;
    name: string;
    artist: string;
    year: number | null;
    songCount: number;
    createdAt: string;
  }[];
  playlists: {
    id: string;
    name: string;
    owner: string | null;
    public: boolean;
    songCount: number;
    durationSec: number;
    changedAt: string;
  }[];
  libraries: { id: number; name: string }[];
}

let owner: CookieJar;
let guest: CookieJar;

beforeAll(async () => {
  await bootstrapAdmin();
  await seedConsoleUser("Owner", "overview");
  await seedConsoleUser("Guest", "nothing", GUEST_ROLE);
  owner = (await signIn(send, ORIGIN, "owner", "overview")).jar;
  guest = (await signIn(send, ORIGIN, "guest", "nothing")).jar;
});

function overview(jar?: CookieJar) {
  return send(consoleRequest(ORIGIN, "/api/overview/library", { jar }));
}

async function libraryOf(jar: CookieJar): Promise<LibraryOverview> {
  const response = await overview(jar);
  expect(response.status).toBe(200);
  return response.json();
}

describe("GET /api/overview/library on an empty library", () => {
  it("answers zeros and empty lists", async () => {
    expect(await libraryOf(owner)).toEqual({
      counts: { artists: 0, albums: 0, tracks: 0, genres: 0, durationSec: 0, sizeBytes: 0 },
      genres: [],
      recentAlbums: [],
      playlists: [],
      libraries: [{ id: 1, name: "Music Library" }],
    });
  });
});

describe("GET /api/overview/library, refused", () => {
  it("answers 401 without a session", async () => {
    const response = await overview();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  it("answers 403 to a role without library:read", async () => {
    const response = await overview(guest);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });
});

describe("GET /api/overview/library on a seeded library", () => {
  let body: LibraryOverview;

  beforeAll(async () => {
    await seedFixtureLibrary();

    // More albums than the overview shows, some added at the same instant,
    // so the newest twelve are a real cut and the id has ties to break.
    for (let index = 0; index < 14; index++) {
      const albumArtist = `Overview Artist ${index % 3}`;
      if (index < 3) {
        await seedArtist({ name: albumArtist });
      }
      await seedAlbum({
        name: `Overview Album ${index}`,
        albumArtist,
        year: index % 4 === 0 ? null : 2000 + index,
        songCount: index + 1,
        duration: 60.5 * (index + 1),
        size: 1_000 * (index + 1),
        createdAt: new Date(SEED_TIME.getTime() + Math.floor(index / 2) * 60_000),
      });
    }

    const adminId = await adminUserId();
    await seedPlaylist({ r2Key: "playlists/Road Trip.m3u", ownerId: adminId, public: false });
    await seedPlaylist({ r2Key: "playlists/Ambient.m3u", ownerId: "no-such-user" });
    await seedPlaylist({
      r2Key: "playlists/again/Ambient.m3u",
      ownerId: adminId,
      changedAt: new Date(SEED_TIME.getTime() + 1),
    });

    body = await libraryOf(owner);
  });

  it("counts what the tables hold", async () => {
    const db = database(testEnv);
    const [artists] = await db.select({ n: count() }).from(artist);
    const [albums] = await db
      .select({
        n: count(),
        duration: sql<number>`sum(${album.duration})`,
        size: sql<number>`sum(${album.size})`,
      })
      .from(album);
    const [tracks] = await db.select({ n: count() }).from(track);

    expect(body.counts).toEqual({
      artists: artists?.n,
      albums: albums?.n,
      // Read from the albums' stored song counts, which the seeds, like the
      // scan, keep equal to the tracks they hold, plus the albums seeded
      // above with counts and no track rows.
      tracks: (tracks?.n ?? 0) + (14 * 15) / 2,
      genres: body.genres.length,
      durationSec: albums?.duration,
      sizeBytes: albums?.size,
    });
    expect(body.counts.artists).toBeGreaterThan(0);
  });

  it("lists the genres getGenres lists, in its order", async () => {
    const genres = (await browse("getGenres")).genres?.genre ?? [];

    expect(genres.length).toBeGreaterThan(0);
    expect(body.genres).toEqual(
      genres.map(({ value, songCount, albumCount }) => ({ name: value, songCount, albumCount })),
    );
  });

  it("lists the first twelve albums of getAlbumList2?type=newest", async () => {
    const newest = (await list("getAlbumList2", { type: "newest", size: "12" })).albumList2?.album;

    expect(newest).toHaveLength(12);
    expect(body.recentAlbums).toEqual(
      (newest ?? []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        artist: entry.artist ?? "",
        year: entry.year ?? null,
        songCount: entry.songCount,
        createdAt: entry.created,
      })),
    );
  });

  it("lists every playlist by name then id, with its owner's name", async () => {
    const rows = await database(testEnv).select().from(playlist);
    const byNameThenId = [...rows].sort(
      (left, right) =>
        (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) ||
        (left.id < right.id ? -1 : 1),
    );

    expect(body.playlists.map((entry) => entry.id)).toEqual(
      byNameThenId.map((row) => prefixedId("playlist", row.id)),
    );
    expect(body.playlists.find((entry) => entry.name === "Road Trip")).toEqual({
      id: prefixedId("playlist", rows.find((row) => row.name === "Road Trip")?.id ?? ""),
      name: "Road Trip",
      owner: "admin",
      public: false,
      songCount: 0,
      durationSec: 0,
      changedAt: SEED_TIME.toISOString(),
    });
    // A row whose owner is no user names none.
    expect(body.playlists.filter((entry) => entry.owner === null)).toHaveLength(1);
  });

  it("costs one round trip of five statements, and writes nothing", async () => {
    d1.reset();
    await libraryOf(owner);
    const spent = cost(d1.statements);

    expect(spent).toMatchObject({ statements: 5, roundTrips: 1, rowsWritten: 0 });
    expect(d1.statements.map(shape)).toEqual([
      "select album",
      "select track",
      "select album",
      "select playlist",
      "select library",
    ]);
    // Every library is v0.5.0's SQL, with no library predicate.
    expect(
      d1.statements.slice(0, 4).some((statement) => /library_id"? in \(/.test(statement.sql)),
    ).toBe(false);
  });
});
