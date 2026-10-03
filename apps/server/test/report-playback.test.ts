import { SELF } from "cloudflare:test";
import { albumId, artistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { write, writeQuery } from "./annotations-support";
import { bootstrapAdmin, browse } from "./browsing-support";
import {
  adminId,
  callCounting,
  clearSession,
  nowPlayingFeed,
  seedSession,
  storedSession,
} from "./now-playing-support";
import { BASE, seedAlbum, seedAnnotation, seedArtist, seedTrack } from "./support";

/**
 * `reportPlayback`, the OpenSubsonic `playbackReport` extension (#74): a
 * client reports where it is in a track and what it is doing, the caller's
 * session is stored as Navidrome's play tracker would hold it, and a stop far
 * enough in counts the play.
 *
 * What a report did is read back over HTTP — through `getNowPlaying`,
 * `getSong`, `getAlbum` and `getArtist` — and from the stored row where the
 * instant it expires is the thing under test. What a report cost is read
 * through the Worker's own handler against a D1 that counts (`callCounting`).
 */

const ARTIST = "Vega";
const ALBUM = "Lyra";
const YEAR = 2020;

interface Song {
  readonly key: string;
  readonly title: string;
  readonly duration: number;
}

const SONGS = {
  /** Ten minutes: the four-minute cap on the play threshold applies. */
  long: { key: `${ARTIST}/${ALBUM}/01 Long.mp3`, title: "Long", duration: 600 },
  /** Three minutes: the half-way threshold applies. */
  short: { key: `${ARTIST}/${ALBUM}/02 Short.mp3`, title: "Short", duration: 180 },
  other: { key: `${ARTIST}/${ALBUM}/03 Other.mp3`, title: "Other", duration: 200 },
  fourth: { key: `${ARTIST}/${ALBUM}/04 Fourth.mp3`, title: "Fourth", duration: 300 },
  /** A track whose length was never read: its TTL is the one-minute floor. */
  unknown: { key: `${ARTIST}/${ALBUM}/05 Unknown.mp3`, title: "Unknown", duration: 0 },
} satisfies Record<string, Song>;

const id = (song: Song) => prefixedId("track", trackId(1, song.key));
const ALBUM_ID = prefixedId("album", albumId(1, ARTIST, ALBUM, YEAR));
const ARTIST_ID = prefixedId("artist", artistId(ARTIST));

/** A complete, valid report of `song`, with whatever a test overrides. */
function reportOf(song: Song, overrides: Record<string, string> = {}): Record<string, string> {
  return { mediaId: id(song), mediaType: "song", positionMs: "0", state: "playing", ...overrides };
}

function report(song: Song, overrides: Record<string, string> = {}) {
  return write("reportPlayback", reportOf(song, overrides));
}

/** The play data of the track, its album and its artist, as a client reads them. */
async function playData(song: Song) {
  const [track, album, artist] = await Promise.all([
    browse("getSong", { id: id(song) }),
    browse("getAlbum", { id: ALBUM_ID }),
    browse("getArtist", { id: ARTIST_ID }),
  ]);

  return {
    track: track.song?.playCount ?? 0,
    album: album.album?.playCount ?? 0,
    artist: artist.artist?.playCount ?? 0,
    played: track.song?.played,
  };
}

/** How far `instant` is from `expected`, in milliseconds either way. */
function distance(instant: Date | undefined, expected: number): number {
  return Math.abs((instant?.getTime() ?? 0) - expected);
}

beforeAll(async () => {
  await bootstrapAdmin();
  await seedArtist({ name: ARTIST });
  await seedAlbum({ name: ALBUM, albumArtist: ARTIST, year: YEAR, songCount: 5 });
  for (const song of Object.values(SONGS)) {
    await seedTrack({
      r2Key: song.key,
      title: song.title,
      album: ALBUM,
      albumArtist: ARTIST,
      year: YEAR,
      duration: song.duration,
    });
  }
});

beforeEach(clearSession);

describe("a request it refuses", () => {
  it.each(["mediaId", "mediaType", "positionMs", "state"])(
    "is error 10 without %s",
    async (name) => {
      const params = reportOf(SONGS.long);
      delete params[name];

      expect((await write("reportPlayback", params)).error?.code).toBe(10);
    },
  );

  it.each([
    ["a positionMs that is not a number", { positionMs: "soon" }],
    ["a negative positionMs", { positionMs: "-1" }],
    ["a state the extension does not define", { state: "rewinding" }],
    ["a playbackRate of 0", { playbackRate: "0" }],
    ["a negative playbackRate", { playbackRate: "-1.5" }],
    ["a playbackRate of NaN", { playbackRate: "NaN" }],
    ["an infinite playbackRate", { playbackRate: "Inf" }],
  ])("is error 0 for %s", async (_label, overrides) => {
    expect((await report(SONGS.long, overrides)).error?.code).toBe(0);
    expect(await storedSession()).toBeNull();
  });

  it("is error 70 for a track id that names nothing", async () => {
    const body = await write("reportPlayback", {
      ...reportOf(SONGS.long),
      mediaId: prefixedId("track", trackId(1, "Nobody/Nothing/None.mp3")),
    });

    expect(body.error?.code).toBe(70);
  });

  it("is error 70 for an id that is not a track id", async () => {
    const body = await write("reportPlayback", { ...reportOf(SONGS.long), mediaId: ALBUM_ID });

    expect(body.error?.code).toBe(70);
  });

  it.each([
    ["a position no track reaches", { positionMs: "9000000000000000000" }],
    ["a rate that barely moves", { playbackRate: "1e-300" }],
  ])("answers ok for %s, as Navidrome does", async (_label, overrides) => {
    expect((await report(SONGS.long, overrides)).status).toBe("ok");
    expect(await storedSession()).not.toBeNull();
  });

  it("reads a playbackRate that is not a number as the default, as Navidrome does", async () => {
    expect((await report(SONGS.long, { playbackRate: "fast" })).status).toBe("ok");
    expect((await storedSession())?.playbackRate).toBe(1);
  });
});

describe("the envelope", () => {
  it("is an empty ok in JSON", async () => {
    expect(await report(SONGS.long)).toEqual({
      status: "ok",
      version: "1.16.1",
      type: "stratosonic",
      serverVersion: expect.any(String),
      openSubsonic: true,
    });
  });

  it.each(["/rest/reportPlayback", "/rest/reportPlayback.view"])(
    "is an empty ok in XML on %s",
    async (path) => {
      const response = await SELF.fetch(`${BASE}${path}?${writeQuery(reportOf(SONGS.long))}`);
      const xml = await response.text();

      expect(xml).toContain('status="ok"');
      expect(xml).toMatch(/<subsonic-response [^>]*\/>$/);
    },
  );

  it("accepts its parameters in a form-encoded POST body", async () => {
    const response = await SELF.fetch(`${BASE}/rest/reportPlayback.view`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: writeQuery({ ...reportOf(SONGS.long, { positionMs: "1234" }), f: "json" }),
    });
    const body = (await response.json()) as { "subsonic-response": { status: string } };

    expect(body["subsonic-response"].status).toBe("ok");
    expect((await storedSession())?.positionMs).toBe(1234);
  });
});

describe("a session's expiry", () => {
  it("is the time the track has left, plus five seconds, while playing", async () => {
    const before = Date.now();
    await report(SONGS.long, { positionMs: "60000" });

    // 540 s left at normal speed.
    expect(distance((await storedSession())?.expiresAt, before + 545_000)).toBeLessThan(2_000);
  });

  it("is the time left at the reported rate", async () => {
    const before = Date.now();
    await report(SONGS.long, { positionMs: "60000", playbackRate: "2" });

    // 540 s of track at double speed is 270 s.
    expect(distance((await storedSession())?.expiresAt, before + 275_000)).toBeLessThan(2_000);
  });

  it("is the same for a session starting", async () => {
    const before = Date.now();
    await report(SONGS.short, { state: "starting" });

    expect((await storedSession())?.state).toBe("starting");
    expect(distance((await storedSession())?.expiresAt, before + 185_000)).toBeLessThan(2_000);
  });

  it("is never under a minute", async () => {
    const before = Date.now();
    await report(SONGS.long, { positionMs: "599000" });

    expect(distance((await storedSession())?.expiresAt, before + 60_000)).toBeLessThan(2_000);
  });

  it("is never over a day", async () => {
    const before = Date.now();
    await report(SONGS.long, { playbackRate: "1e-300" });

    expect(distance((await storedSession())?.expiresAt, before + 24 * 60 * 60_000)).toBeLessThan(
      2_000,
    );
  });

  it("is half an hour while paused", async () => {
    const before = Date.now();
    await report(SONGS.long, { state: "paused", positionMs: "60000" });

    expect(distance((await storedSession())?.expiresAt, before + 30 * 60_000)).toBeLessThan(2_000);
  });
});

describe("a stop", () => {
  it("counts a play on the track, its album and its artist at the threshold", async () => {
    const before = await playData(SONGS.long);
    await report(SONGS.long, { positionMs: "10000" });

    // Ten minutes of track: four minutes in is enough.
    await report(SONGS.long, { state: "stopped", positionMs: "240000" });

    const after = await playData(SONGS.long);
    expect(after.track).toBe(before.track + 1);
    expect(after.album).toBe(before.album + 1);
    expect(after.artist).toBe(before.artist + 1);
    expect(after.played).toBeTruthy();
  });

  it("counts half-way through a track shorter than eight minutes", async () => {
    const before = await playData(SONGS.short);
    await report(SONGS.short, { state: "stopped", positionMs: "90000" });

    expect((await playData(SONGS.short)).track).toBe(before.track + 1);
  });

  it("counts no play below the threshold", async () => {
    const before = await playData(SONGS.long);
    await report(SONGS.long, { state: "stopped", positionMs: "239999" });

    expect(await playData(SONGS.long)).toEqual(before);
  });

  it("counts no play with ignoreScrobble", async () => {
    const before = await playData(SONGS.long);
    await report(SONGS.long, { state: "stopped", positionMs: "600000", ignoreScrobble: "true" });

    expect(await playData(SONGS.long)).toEqual(before);
  });

  it("ends the session", async () => {
    await report(SONGS.long, { positionMs: "10000" });
    await report(SONGS.long, { state: "stopped", positionMs: "20000", ignoreScrobble: "true" });

    expect(await storedSession()).toBeNull();
    expect(await nowPlayingFeed()).toEqual([]);
  });

  it("never moves played backwards", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60_000);
    await seedAnnotation({
      userId: await adminId(),
      starred: false,
      itemType: "track",
      itemId: trackId(1, SONGS.fourth.key),
      playCount: 3,
      playDate: future,
    });

    await report(SONGS.fourth, { state: "stopped", positionMs: "300000" });

    const song = (await browse("getSong", { id: id(SONGS.fourth) })).song;
    expect(song?.playCount).toBe(4);
    expect(song?.played).toBe(future.toISOString());
  });
});

describe("reports that arrive out of order", () => {
  it("leaves a playing session alone on a late starting for its track", async () => {
    const startedAt = new Date(Date.now() - 30_000);
    await seedSession({ trackId: trackId(1, SONGS.long.key), positionMs: 30_000, startedAt });

    const counted = await callCounting(
      "reportPlayback",
      reportOf(SONGS.long, { state: "starting" }),
    );

    expect(counted.body.status).toBe("ok");
    expect(counted.rowsWritten).toBe(0);
    const session = await storedSession();
    expect(session?.state).toBe("playing");
    expect(session?.positionMs).toBe(30_000);
    expect(session?.startedAt).toEqual(startedAt);
  });

  it("restarts a paused session on a starting for its track", async () => {
    await seedSession({ trackId: trackId(1, SONGS.long.key), state: "paused", positionMs: 30_000 });
    await report(SONGS.long, { state: "starting" });

    const session = await storedSession();
    expect(session?.state).toBe("starting");
    expect(session?.positionMs).toBe(0);
  });

  it("replaces a playing session on a starting for another track", async () => {
    await seedSession({ trackId: trackId(1, SONGS.long.key), positionMs: 30_000 });
    await report(SONGS.short, { state: "starting" });

    expect((await storedSession())?.trackId).toBe(trackId(1, SONGS.short.key));
  });

  it("keeps the session on a late stop for another track, still counting that play", async () => {
    await seedSession({ trackId: trackId(1, SONGS.long.key), positionMs: 5_000 });
    const before = await playData(SONGS.other);

    await report(SONGS.other, { state: "stopped", positionMs: "200000" });

    // Navidrome counts the play before it looks at the session, and then
    // leaves a session on another track alone.
    expect((await storedSession())?.trackId).toBe(trackId(1, SONGS.long.key));
    expect((await playData(SONGS.other)).track).toBe(before.track + 1);
  });

  it("starts a playing session on another track from its reported position", async () => {
    await seedSession({ trackId: trackId(1, SONGS.long.key), positionMs: 5_000 });
    const before = Date.now();
    await report(SONGS.short, { positionMs: "60000" });

    const session = await storedSession();
    expect(session?.trackId).toBe(trackId(1, SONGS.short.key));
    expect(distance(session?.startedAt, before - 60_000)).toBeLessThan(2_000);
  });

  it("keeps the start of a session across its playing and paused reports", async () => {
    const startedAt = new Date(Date.now() - 90_000);
    await seedSession({ trackId: trackId(1, SONGS.long.key), positionMs: 5_000, startedAt });
    await report(SONGS.long, { state: "paused", positionMs: "95000" });

    expect((await storedSession())?.startedAt).toEqual(startedAt);
  });
});

describe("the now-playing feed", () => {
  it("carries the state, the position moved on at the rate, and the rate", async () => {
    await seedSession({
      trackId: trackId(1, SONGS.long.key),
      positionMs: 30_000,
      playbackRate: 1.5,
      reportedAt: new Date(Date.now() - 10_000),
    });

    const [entry] = await nowPlayingFeed();
    expect(entry?.title).toBe("Long");
    expect(entry?.state).toBe("playing");
    expect(entry?.playbackRate).toBe(1.5);
    // Ten seconds at one and a half times is fifteen seconds of track.
    expect(Math.abs((entry?.positionMs ?? 0) - 45_000)).toBeLessThan(1_000);
    expect(entry?.playerId).toBe(1);
    expect(entry?.playerName).toBe("Substreamer");
  });

  it("never puts a playing session past the end of its track", async () => {
    await seedSession({
      trackId: trackId(1, SONGS.short.key),
      positionMs: 170_000,
      reportedAt: new Date(Date.now() - 60_000),
    });

    expect((await nowPlayingFeed())[0]?.positionMs).toBe(180_000);
  });

  it("leaves a paused session where it was reported", async () => {
    await seedSession({
      trackId: trackId(1, SONGS.long.key),
      state: "paused",
      positionMs: 30_000,
      reportedAt: new Date(Date.now() - 60_000),
    });

    const [entry] = await nowPlayingFeed();
    expect(entry?.state).toBe("paused");
    expect(entry?.positionMs).toBe(30_000);
  });

  it("leaves out a session past its expiry", async () => {
    await seedSession({ trackId: trackId(1, SONGS.long.key), expiresAt: new Date(Date.now() - 1) });

    expect(await nowPlayingFeed()).toEqual([]);
  });

  it("renders the extension's attributes in XML", async () => {
    await report(SONGS.long, { positionMs: "1000" });

    const xml = await (
      await SELF.fetch(`${BASE}/rest/getNowPlaying.view?${writeQuery({})}`)
    ).text();
    expect(xml).toMatch(
      /<entry [^>]*username="admin" minutesAgo="0" playerId="1" playerName="Substreamer" state="playing" positionMs="\d+" playbackRate="1"/,
    );
  });
});

describe("what a report costs D1", () => {
  it("is one read and one upsert for a report that changes the session", async () => {
    const counted = await callCounting("reportPlayback", reportOf(SONGS.long));

    expect(counted.body.status).toBe("ok");
    expect(counted.statements).toHaveLength(2);
    expect(counted.subrequests).toBe(2);
    expect(counted.rowsWritten).toBeGreaterThan(0);
  });

  it("writes nothing for a playing report where the estimate already is", async () => {
    await seedSession({
      trackId: trackId(1, SONGS.long.key),
      positionMs: 30_000,
      reportedAt: new Date(Date.now() - 10_000),
    });

    const counted = await callCounting(
      "reportPlayback",
      reportOf(SONGS.long, { positionMs: "41000" }),
    );

    expect(counted.body.status).toBe("ok");
    expect(counted.statements).toHaveLength(1);
    expect(counted.rowsWritten).toBe(0);
    expect((await storedSession())?.positionMs).toBe(30_000);
  });

  it("writes a playing report more than two seconds off the estimate", async () => {
    await seedSession({
      trackId: trackId(1, SONGS.long.key),
      positionMs: 30_000,
      reportedAt: new Date(Date.now() - 10_000),
    });

    const counted = await callCounting(
      "reportPlayback",
      reportOf(SONGS.long, { positionMs: "90000" }),
    );

    expect(counted.rowsWritten).toBeGreaterThan(0);
    expect((await storedSession())?.positionMs).toBe(90_000);
  });

  it("writes a report that changes the rate", async () => {
    await seedSession({ trackId: trackId(1, SONGS.long.key), positionMs: 30_000 });

    const counted = await callCounting(
      "reportPlayback",
      reportOf(SONGS.long, { positionMs: "30000", playbackRate: "1.25" }),
    );

    expect(counted.rowsWritten).toBeGreaterThan(0);
    expect((await storedSession())?.playbackRate).toBe(1.25);
  });

  it("writes a report that changes the state", async () => {
    await seedSession({ trackId: trackId(1, SONGS.long.key), positionMs: 30_000 });

    const counted = await callCounting(
      "reportPlayback",
      reportOf(SONGS.long, { state: "paused", positionMs: "30000" }),
    );

    expect(counted.rowsWritten).toBeGreaterThan(0);
    expect((await storedSession())?.state).toBe("paused");
  });

  it("writes nothing for a paused report refreshed within five minutes", async () => {
    await seedSession({
      trackId: trackId(1, SONGS.long.key),
      state: "paused",
      positionMs: 30_000,
      reportedAt: new Date(Date.now() - 4 * 60_000),
    });

    const counted = await callCounting(
      "reportPlayback",
      reportOf(SONGS.long, { state: "paused", positionMs: "30000" }),
    );

    expect(counted.rowsWritten).toBe(0);
  });

  it("refreshes a paused session once five minutes have passed", async () => {
    await seedSession({
      trackId: trackId(1, SONGS.long.key),
      state: "paused",
      positionMs: 30_000,
      reportedAt: new Date(Date.now() - 6 * 60_000),
    });
    const before = Date.now();

    const counted = await callCounting(
      "reportPlayback",
      reportOf(SONGS.long, { state: "paused", positionMs: "30000" }),
    );

    expect(counted.rowsWritten).toBeGreaterThan(0);
    expect(distance((await storedSession())?.expiresAt, before + 30 * 60_000)).toBeLessThan(2_000);
  });

  it("moves on the floored expiry of a track of unknown length", async () => {
    // Forty seconds into a session that the one-minute floor ends at 60 s:
    // skipping the report would drop the session while the client plays on.
    await seedSession({
      trackId: trackId(1, SONGS.unknown.key),
      positionMs: 0,
      reportedAt: new Date(Date.now() - 40_000),
      expiresAt: new Date(Date.now() + 20_000),
    });
    const before = Date.now();

    const counted = await callCounting(
      "reportPlayback",
      reportOf(SONGS.unknown, { positionMs: "40000" }),
    );

    expect(counted.rowsWritten).toBeGreaterThan(0);
    expect(distance((await storedSession())?.expiresAt, before + 60_000)).toBeLessThan(2_000);
  });

  it("still skips a report on such a track while its expiry is fresh", async () => {
    await seedSession({
      trackId: trackId(1, SONGS.unknown.key),
      positionMs: 0,
      reportedAt: new Date(Date.now() - 10_000),
      expiresAt: new Date(Date.now() + 50_000),
    });

    const counted = await callCounting(
      "reportPlayback",
      reportOf(SONGS.unknown, { positionMs: "10000" }),
    );

    expect(counted.rowsWritten).toBe(0);
  });

  it("writes an expired session's report, whatever it repeats", async () => {
    await seedSession({
      trackId: trackId(1, SONGS.long.key),
      positionMs: 30_000,
      expiresAt: new Date(Date.now() - 1),
    });

    const counted = await callCounting(
      "reportPlayback",
      reportOf(SONGS.long, { positionMs: "30000" }),
    );

    expect(counted.rowsWritten).toBeGreaterThan(0);
  });

  it("is one read and one batch for a stop that counts a play", async () => {
    await seedSession({ trackId: trackId(1, SONGS.long.key), positionMs: 250_000 });

    const counted = await callCounting(
      "reportPlayback",
      reportOf(SONGS.long, { state: "stopped", positionMs: "250000" }),
    );

    expect(counted.body.status).toBe("ok");
    // The read, then the delete and the track, album and artist plays.
    expect(counted.statements).toHaveLength(5);
    expect(counted.statements.slice(1).every((each) => each.batch === 0)).toBe(true);
    expect(counted.subrequests).toBe(2);
  });

  it("is one read and nothing else for a stop with nothing to do", async () => {
    const counted = await callCounting(
      "reportPlayback",
      reportOf(SONGS.long, { state: "stopped", positionMs: "0", ignoreScrobble: "true" }),
    );

    expect(counted.statements).toHaveLength(1);
    expect(counted.rowsWritten).toBe(0);
  });
});
