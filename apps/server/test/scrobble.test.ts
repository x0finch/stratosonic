import { SELF } from "cloudflare:test";
import { prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { write, writeQuery, writeXml } from "./annotations-support";
import { bootstrapAdmin, browse, type SubsonicSongElement } from "./browsing-support";
import { BASE, seedAlbum, seedArtist, seedTrack } from "./support";

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
}

const SONGS = {
  alpha: { key: `${ARTIST}/${ALBUM}/01 Alpha.mp3`, title: "Alpha" },
  bravo: { key: `${ARTIST}/${ALBUM}/02 Bravo.mp3`, title: "Bravo" },
  charlie: { key: `${ARTIST}/${ALBUM}/03 Charlie.mp3`, title: "Charlie" },
  delta: { key: `${ARTIST}/${ALBUM}/04 Delta.mp3`, title: "Delta" },
  echo: { key: `${ARTIST}/${ALBUM}/05 Echo.mp3`, title: "Echo" },
} satisfies Record<string, Song>;

const id = (song: Song) => prefixedId("track", trackId(song.key));

interface NowPlayingEntry extends SubsonicSongElement {
  username: string;
  minutesAgo: number;
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

/** A song's play count, or 0 when it has none, from getSong. */
async function playCountOf(song: Song): Promise<number> {
  return (await browse("getSong", { id: id(song) })).song?.playCount ?? 0;
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
    // Park an old now-playing so the feed is empty of current entries first.
    await write("scrobble", { id: id(SONGS.alpha), submission: "false", time: "1000000000000" });

    const before = await playCountOf(SONGS.alpha);
    await write("scrobble", { id: id(SONGS.alpha) });

    const song = (await browse("getSong", { id: id(SONGS.alpha) })).song;
    expect(song?.playCount).toBe(before + 1);
    expect(song?.played).toBeTruthy();

    expect((await nowPlaying()).map((entry) => entry.title)).not.toContain("Alpha");
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

    expect(await playCountOf(SONGS.bravo)).toBe(before);
  });

  it("drops an entry older than the TTL window", async () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60_000;
    await write("scrobble", {
      id: id(SONGS.bravo),
      submission: "false",
      time: String(twoHoursAgo),
    });

    expect((await nowPlaying()).map((entry) => entry.title)).not.toContain("Bravo");
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
});

describe("envelope", () => {
  it("answers scrobble with an empty ok in XML", async () => {
    const xml = await writeXml("scrobble", { id: id(SONGS.alpha) });

    expect(xml).toContain('status="ok"');
    expect(xml).not.toContain("<error");
  });
});
