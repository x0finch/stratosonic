import { nowPlaying } from "@stratosonic/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { bootstrapAdmin } from "./browsing-support";
import {
  type CookieJar,
  consoleRequest,
  cost,
  countingD1,
  defineLibraryReaderRole,
  GUEST_ROLE,
  LIBRARY_READER_ROLE,
  seedConsoleUser,
  shape,
  signIn,
} from "./console-auth-support";
import { adminUserId } from "./lists-support";
import { nowPlayingFeed } from "./now-playing-support";
import { seedFixtureLibrary, seedTrack, seedUser, testEnv } from "./support";

/**
 * `GET /api/overview/live` (#82, "API: overview"): the scan's status and who
 * is listening, the one overview route the console polls, in one D1 round
 * trip. The scan half is checked against `getScanStatus` in
 * test/overview-scan.test.ts; this file covers the request, its cost and the
 * listeners, which must agree with `getNowPlaying`.
 */

const ORIGIN = "https://overview-live.stratosonic.test";
const d1 = countingD1(testEnv.DB);
const env: Env = { ...testEnv, DB: d1.binding };
const app = createApp();
const send = (request: Request) => app.request(request, undefined, env);

/**
 * Takes the registry's test role back out after this file: it grants
 * `library:read` and not `activity:read`, which no release's role does yet.
 */
let forgetLibraryReader: () => void = () => {};

interface LiveOverview {
  scan: {
    running: boolean;
    phase: string | null;
    progress: unknown;
    estimatedTotal: number | null;
    last: unknown;
    scheduled: unknown;
  };
  nowPlaying:
    | {
        username: string;
        playerName: string;
        state: string;
        positionMs: number;
        playbackRate: number;
        startedAt: string;
        track: {
          id: string;
          title: string;
          artist: string;
          album: string;
          albumId: string;
          durationSec: number;
        };
      }[]
    | null;
  serverTime: string;
}

let owner: CookieJar;
let guest: CookieJar;
let reader: CookieJar;

beforeAll(async () => {
  forgetLibraryReader = defineLibraryReaderRole();

  await bootstrapAdmin();
  await seedConsoleUser("Owner", "overview");
  await seedConsoleUser("Guest", "nothing", GUEST_ROLE);
  await seedConsoleUser("Reader", "library", LIBRARY_READER_ROLE);
  owner = (await signIn(send, ORIGIN, "owner", "overview")).jar;
  guest = (await signIn(send, ORIGIN, "guest", "nothing")).jar;
  reader = (await signIn(send, ORIGIN, "reader", "library")).jar;
});

afterAll(() => {
  forgetLibraryReader();
});

function live(jar?: CookieJar) {
  return send(consoleRequest(ORIGIN, "/api/overview/live", { jar }));
}

async function liveOf(jar: CookieJar): Promise<LiveOverview> {
  const response = await live(jar);
  expect(response.status).toBe(200);
  return response.json();
}

describe("GET /api/overview/live before any scan or listener", () => {
  it("answers no scan, no last pass and nobody listening", async () => {
    const before = Date.now();
    const body = await liveOf(owner);

    expect(body).toEqual({
      scan: {
        running: false,
        phase: null,
        progress: null,
        library: null,
        paused: null,
        estimatedTotal: null,
        last: null,
        scheduled: null,
      },
      nowPlaying: [],
      serverTime: expect.any(String),
    });
    expect(Date.parse(body.serverTime)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(body.serverTime)).toBeLessThanOrEqual(Date.now());
  });
});

describe("GET /api/overview/live, refused", () => {
  it("answers 401 without a session", async () => {
    const response = await live();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  it("answers 403 to a role without library:read", async () => {
    const response = await live(guest);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });
});

describe("GET /api/overview/live with listeners", () => {
  /** When the playing session last reported, well before the request. */
  const REPORTED = Date.now() - 5_000;

  beforeAll(async () => {
    const { tracks } = await seedFixtureLibrary();
    const [first, third] = tracks;
    if (!first || !third) {
      throw new Error("the fixtures have fewer than two tracks");
    }
    // Long enough that the playing session's position is nowhere near the
    // end, which would cap it: the fixtures last about a second.
    const second = await seedTrack({ r2Key: "Live Artist/Long Album/Long.mp3", duration: 600 });
    const listenerId = await seedUser("listener", "sesame");
    const goneId = await seedUser("gone", "sesame");

    await database(testEnv)
      .insert(nowPlaying)
      .values([
        {
          userId: await adminUserId(),
          trackId: first.id,
          playerName: "Substreamer",
          state: "paused",
          positionMs: 12_000,
          playbackRate: 1,
          startedAt: new Date(REPORTED - 60_000),
          reportedAt: new Date(REPORTED),
          expiresAt: new Date(REPORTED + 30 * 60_000),
        },
        {
          userId: listenerId,
          trackId: second.id,
          playerName: "Feishin",
          state: "playing",
          positionMs: 200,
          playbackRate: 1.5,
          startedAt: new Date(REPORTED - 1_000),
          reportedAt: new Date(REPORTED),
          expiresAt: new Date(REPORTED + 30 * 60_000),
        },
        {
          // Expired: no longer listening, as getNowPlaying filters it.
          userId: goneId,
          trackId: third.id,
          playerName: "Gone",
          state: "playing",
          positionMs: 0,
          playbackRate: 1,
          startedAt: new Date(REPORTED - 3_600_000),
          reportedAt: new Date(REPORTED - 3_600_000),
          expiresAt: new Date(REPORTED - 1),
        },
      ]);
  });

  it("lists who getNowPlaying lists, in its order, with the same tracks", async () => {
    const body = await liveOf(owner);
    const feed = await nowPlayingFeed();

    expect(feed).toHaveLength(2);
    expect(
      body.nowPlaying?.map(({ username, playerName, state, playbackRate, track }) => ({
        username,
        playerName,
        state,
        playbackRate,
        track,
      })),
    ).toEqual(
      feed.map((entry) => ({
        username: entry.username,
        playerName: entry.playerName,
        state: entry.state,
        playbackRate: entry.playbackRate,
        track: {
          id: entry.id,
          title: entry.title,
          artist: entry.artist,
          // The long track has no album row, which getNowPlaying leaves out
          // and the console reads as an empty name.
          album: entry.album ?? "",
          albumId: entry.parent,
          durationSec: expect.closeTo(entry.duration ?? 0, 0),
        },
      })),
    );
  });

  it("moves a playing session's position on to the server's time, at its rate", async () => {
    const body = await liveOf(owner);
    const playing = body.nowPlaying?.find((entry) => entry.state === "playing");
    const paused = body.nowPlaying?.find((entry) => entry.state === "paused");

    expect(paused).toMatchObject({ username: "admin", positionMs: 12_000 });
    expect(playing).toMatchObject({
      username: "listener",
      positionMs: 200 + Math.trunc((Date.parse(body.serverTime) - REPORTED) * 1.5),
      startedAt: new Date(REPORTED - 1_000).toISOString(),
    });
    expect(playing?.track.id).toMatch(/^tr-/);
    expect(paused?.track.albumId).toMatch(/^al-/);
  });

  it("makes exactly one D1 round trip, of three statements, and writes nothing", async () => {
    d1.reset();
    await liveOf(owner);

    expect(cost(d1.statements)).toMatchObject({ statements: 3, roundTrips: 1, rowsWritten: 0 });
    expect(d1.statements.map(shape)).toEqual([
      "select property",
      "select library",
      "select now_playing",
    ]);
  });

  it("answers nowPlaying: null to a role without activity:read, reading no listener", async () => {
    d1.reset();
    const body = await liveOf(reader);

    expect(body.nowPlaying).toBeNull();
    expect(cost(d1.statements)).toMatchObject({ statements: 2, roundTrips: 1, rowsWritten: 0 });
    expect(d1.statements.map(shape)).toEqual(["select property", "select library"]);
    expect(body.scan).toEqual((await liveOf(owner)).scan);
  });
});
