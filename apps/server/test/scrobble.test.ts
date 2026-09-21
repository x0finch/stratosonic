import { SELF } from "cloudflare:test";
import { prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { registerNowPlaying } from "../src/nowplaying/repository";
import { findUserByUsername } from "../src/users/repository";
import { write, writeQuery, writeXml } from "./annotations-support";
import { ADMIN, bootstrapAdmin, browse, type SubsonicSongElement } from "./browsing-support";
import { BASE, seedAlbum, seedArtist, seedTrack, testEnv } from "./support";

/**
 * `scrobble` and `getNowPlaying`: a listener's plays count, and a "now
 * playing" feed that expires on its own.
 *
 * The two halves of `scrobble` are exclusive — a play (`submission=true`, the
 * default) grows the count, a now-playing (`submission=false`) only appears in
 * the feed — and each is read back over HTTP through `getSong` and
 * `getNowPlaying`.
 */

const ARTIST = "Orion";
const ALBUM = "Rigel";
const YEAR = 2015;

interface Song {
  readonly key: string;
  readonly title: string;
  /** Seconds, which is what the now-playing TTL is measured against. */
  readonly duration: number;
}

const SONGS = {
  alpha: { key: `${ARTIST}/${ALBUM}/01 Alpha.mp3`, title: "Alpha", duration: 1 },
  bravo: { key: `${ARTIST}/${ALBUM}/02 Bravo.mp3`, title: "Bravo", duration: 180 },
  charlie: { key: `${ARTIST}/${ALBUM}/03 Charlie.mp3`, title: "Charlie", duration: 1 },
  delta: { key: `${ARTIST}/${ALBUM}/04 Delta.mp3`, title: "Delta", duration: 1 },
  echo: { key: `${ARTIST}/${ALBUM}/05 Echo.mp3`, title: "Echo", duration: 1 },
  /** A track whose length was never read: the TTL floor applies to it. */
  foxtrot: { key: `${ARTIST}/${ALBUM}/06 Foxtrot.mp3`, title: "Foxtrot", duration: 0 },
  golf: { key: `${ARTIST}/${ALBUM}/07 Golf.mp3`, title: "Golf", duration: 1 },
} satisfies Record<string, Song>;

const id = (song: Song) => prefixedId("track", trackId(song.key));

interface NowPlayingEntry extends SubsonicSongElement {
  username: string;
  minutesAgo: number;
  playerId: number;
  playerName?: string;
}

/** Reads getNowPlaying as the bootstrap admin. */
async function nowPlaying(): Promise<NowPlayingEntry[]> {
  const response = await SELF.fetch(`${BASE}/rest/getNowPlaying?${writeQuery({ f: "json" })}`);
  const body = (await response.json()) as {
    "subsonic-response": { nowPlaying?: { entry?: NowPlayingEntry[] } };
  };

  return body["subsonic-response"].nowPlaying?.entry ?? [];
}

/** The titles the feed currently carries. */
async function nowPlayingTitles(): Promise<string[]> {
  return (await nowPlaying()).map((entry) => entry.title);
}

/**
 * Puts the admin's now-playing row in place at a chosen instant.
 *
 * The endpoint stamps a registration with the server's own now, so a test that
 * asks what the TTL does to an entry that started minutes ago has to write the
 * row itself rather than go through `scrobble`.
 */
async function seedNowPlaying(song: Song, startedAt: Date): Promise<void> {
  const admin = await findUserByUsername(database(testEnv), ADMIN);
  if (!admin) {
    throw new Error("the bootstrap admin is missing");
  }

  await registerNowPlaying(
    database(testEnv),
    admin.id,
    trackId(song.key),
    "Substreamer",
    startedAt,
  );
}

/** A song's play count, or 0 when it has none, from getSong. */
async function playCountOf(song: Song): Promise<number> {
  return (await browse("getSong", { id: id(song) })).song?.playCount ?? 0;
}

beforeAll(async () => {
  await bootstrapAdmin();
  await seedArtist({ name: ARTIST });
  await seedAlbum({ name: ALBUM, albumArtist: ARTIST, year: YEAR, songCount: 7 });
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

describe("an empty now-playing feed", () => {
  it("answers with an empty container", async () => {
    expect(await nowPlaying()).toEqual([]);
  });
});

describe("a play submission", () => {
  it("counts the play and sets played, without a now-playing entry", async () => {
    const before = await playCountOf(SONGS.alpha);
    await write("scrobble", { id: id(SONGS.alpha) });

    const song = (await browse("getSong", { id: id(SONGS.alpha) })).song;
    expect(song?.playCount).toBe(before + 1);
    expect(song?.played).toBeTruthy();

    expect(await nowPlayingTitles()).not.toContain("Alpha");
  });

  it("uses a given time as the play instant", async () => {
    const when = 1_600_000_000_000;
    await write("scrobble", { id: id(SONGS.charlie), time: String(when) });

    const song = (await browse("getSong", { id: id(SONGS.charlie) })).song;
    expect(song?.played).toBe(new Date(when).toISOString());
  });

  it("records a play for each id in one call", async () => {
    await write("scrobble", { id: [id(SONGS.delta), id(SONGS.echo)] });

    expect(await playCountOf(SONGS.delta)).toBe(1);
    expect(await playCountOf(SONGS.echo)).toBe(1);
  });

  it("counts a backlogged play without moving played backwards", async () => {
    const now = Date.now();
    await write("scrobble", { id: id(SONGS.golf), time: String(now) });
    // The same track again, with the instant an offline backlog would carry.
    await write("scrobble", { id: id(SONGS.golf), time: "1577836800000" });

    const song = (await browse("getSong", { id: id(SONGS.golf) })).song;
    expect(song?.playCount).toBe(2);
    expect(song?.played).toBe(new Date(now).toISOString());
  });
});

describe("a now-playing submission", () => {
  it("appears in the feed without counting a play", async () => {
    const before = await playCountOf(SONGS.bravo);
    await write("scrobble", { id: id(SONGS.bravo), submission: "false" });

    const entry = (await nowPlaying()).find((each) => each.title === "Bravo");
    expect(entry).toBeDefined();
    expect(entry?.username).toBe("admin");
    expect(entry?.playerName).toBe("Substreamer");
    expect(typeof entry?.minutesAgo).toBe("number");
    // Required by the XSD; Navidrome has no player registry and renders 0.
    expect(entry?.playerId).toBe(0);

    expect(await playCountOf(SONGS.bravo)).toBe(before);
  });

  it("keeps only the last of several ids, the track being played now", async () => {
    await write("scrobble", {
      id: [id(SONGS.alpha), id(SONGS.bravo), id(SONGS.charlie)],
      submission: "false",
    });

    expect(await nowPlayingTitles()).toEqual(["Charlie"]);
  });
});

describe("the now-playing TTL", () => {
  const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1_000);

  it("keeps a three-minute track started two minutes ago", async () => {
    await seedNowPlaying(SONGS.bravo, secondsAgo(120));

    expect(await nowPlayingTitles()).toContain("Bravo");
  });

  it("drops a three-minute track started four minutes ago", async () => {
    await seedNowPlaying(SONGS.bravo, secondsAgo(240));

    expect(await nowPlayingTitles()).not.toContain("Bravo");
  });

  it("keeps a track of unknown length started thirty seconds ago", async () => {
    await seedNowPlaying(SONGS.foxtrot, secondsAgo(30));

    expect(await nowPlayingTitles()).toContain("Foxtrot");
  });

  it("drops a track of unknown length started ninety seconds ago", async () => {
    await seedNowPlaying(SONGS.foxtrot, secondsAgo(90));

    expect(await nowPlayingTitles()).not.toContain("Foxtrot");
  });
});

describe("bad requests", () => {
  it("is error 10 when id is missing", async () => {
    expect((await write("scrobble", {})).error?.code).toBe(10);
  });

  it("is error 70 for an id that names nothing", async () => {
    const body = await write("scrobble", { id: prefixedId("track", trackId("Ghost/None/x.mp3")) });
    expect(body.error?.code).toBe(70);
  });

  it("is error 0 when there are more timestamps than ids", async () => {
    const body = await write("scrobble", {
      id: id(SONGS.alpha),
      time: ["1600000000000", "1600000001000"],
    });

    expect(body.error?.code).toBe(0);
    expect(body.error?.message).toBe("Wrong number of timestamps: 2, should be 1");
  });

  it("is error 0 when there are fewer timestamps than ids", async () => {
    const body = await write("scrobble", {
      id: [id(SONGS.alpha), id(SONGS.bravo)],
      time: "1600000000000",
    });

    expect(body.error?.code).toBe(0);
    expect(body.error?.message).toBe("Wrong number of timestamps: 1, should be 2");
  });

  it("is error 0 for a time that is not a number", async () => {
    const body = await write("scrobble", { id: id(SONGS.alpha), time: "abc" });

    expect(body.error?.code).toBe(0);
    expect(body.error?.message).toContain("time");
  });

  it("does not count a play for a request it refuses", async () => {
    const before = await playCountOf(SONGS.echo);
    await write("scrobble", { id: id(SONGS.echo), time: "abc" });

    expect(await playCountOf(SONGS.echo)).toBe(before);
  });
});

describe("envelope", () => {
  it("answers scrobble with an empty ok in XML", async () => {
    const xml = await writeXml("scrobble", { id: id(SONGS.alpha) });

    expect(xml).toContain('status="ok"');
    expect(xml).not.toContain("<error");
  });
});
