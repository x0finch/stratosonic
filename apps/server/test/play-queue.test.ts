import { SELF } from "cloudflare:test";
import { prefixedId, track, trackId } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { ADMIN, bootstrapAdmin, type SubsonicSongElement } from "./browsing-support";
import { BASE, seedAlbum, seedArtist, seedTrack, seedUser, testEnv } from "./support";

/**
 * `savePlayQueue` and `getPlayQueue`: a listener pauses on one device and
 * resumes on another.
 *
 * Everything is driven over HTTP — the queue is written by one request and
 * read back by the next — because that round trip is the feature: what a
 * client saves has to be what another client is handed.
 */

const ARTIST = "Lyra";
const ALBUM = "Vega";
const YEAR = 2019;

interface Song {
  readonly key: string;
  readonly title: string;
}

const SONGS = {
  alpha: { key: `${ARTIST}/${ALBUM}/01 Alpha.mp3`, title: "Alpha" },
  bravo: { key: `${ARTIST}/${ALBUM}/02 Bravo.mp3`, title: "Bravo" },
  charlie: { key: `${ARTIST}/${ALBUM}/03 Charlie.mp3`, title: "Charlie" },
  delta: { key: `${ARTIST}/${ALBUM}/04 Delta.mp3`, title: "Delta" },
  /** Seeded, queued, and then removed from the library by one test. */
  ghost: { key: `${ARTIST}/${ALBUM}/05 Ghost.mp3`, title: "Ghost" },
} satisfies Record<string, Song>;

const id = (song: Song) => prefixedId("track", trackId(song.key));

const PASSWORD = "sesame";
const OTHER_USER = "listener";
const OTHER_PASSWORD = "open-sesame";

interface Credentials {
  readonly user: string;
  readonly password: string;
}

const AS_ADMIN: Credentials = { user: ADMIN, password: PASSWORD };
const AS_OTHER: Credentials = { user: OTHER_USER, password: OTHER_PASSWORD };

/** `<playQueue>` as the JSON rendering carries it; empty when none is saved. */
interface PlayQueueElement {
  entry?: SubsonicSongElement[];
  current?: string;
  position?: number;
  username?: string;
  changed?: string;
  changedBy?: string;
}

interface Envelope {
  status: string;
  error?: { code: number; message: string };
  playQueue?: PlayQueueElement;
}

/**
 * Credentials plus whatever the call needs. Unlike the shared helper this
 * lets a test override `c`, which is the client name `changedBy` answers
 * with, and repeat `id` to spell out a queue.
 */
function query(
  extra: Record<string, string | readonly string[]> = {},
  credentials: Credentials = AS_ADMIN,
): string {
  const params = new URLSearchParams();
  const all: Record<string, string | readonly string[]> = {
    u: credentials.user,
    p: credentials.password,
    v: "1.16.1",
    c: "Substreamer",
    ...extra,
  };

  for (const [key, value] of Object.entries(all)) {
    for (const item of Array.isArray(value) ? value : [value as string]) {
      params.append(key, item);
    }
  }

  return params.toString();
}

async function call(
  endpoint: string,
  extra: Record<string, string | readonly string[]> = {},
  credentials?: Credentials,
): Promise<Envelope> {
  const response = await SELF.fetch(
    `${BASE}/rest/${endpoint}?${query({ ...extra, f: "json" }, credentials)}`,
  );
  const body = (await response.json()) as { "subsonic-response": Envelope };

  return body["subsonic-response"];
}

async function callXml(
  endpoint: string,
  extra: Record<string, string | readonly string[]> = {},
): Promise<string> {
  return (await SELF.fetch(`${BASE}/rest/${endpoint}?${query(extra)}`)).text();
}

/** The caller's saved queue, as `getPlayQueue` answers with it. */
async function savedQueue(credentials?: Credentials): Promise<PlayQueueElement> {
  const body = await call("getPlayQueue", {}, credentials);
  expect(body.status).toBe("ok");

  return body.playQueue ?? {};
}

/** The titles of the queue's entries, in the order it lists them. */
function titles(queue: PlayQueueElement): string[] {
  return (queue.entry ?? []).map((entry) => entry.title);
}

beforeAll(async () => {
  await bootstrapAdmin();
  await seedUser(OTHER_USER, OTHER_PASSWORD);
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

describe("a caller who has saved nothing", () => {
  it("gets an empty playQueue rather than an error", async () => {
    const body = await call("getPlayQueue");

    expect(body.status).toBe("ok");
    expect(body.error).toBeUndefined();
    expect(body.playQueue).toEqual({});
  });

  it("gets an empty playQueue element in XML", async () => {
    const xml = await callXml("getPlayQueue");

    expect(xml).toContain('status="ok"');
    expect(xml).toContain("<playQueue/>");
  });
});

describe("saving a queue", () => {
  it("answers with an empty ok envelope", async () => {
    const body = await call("savePlayQueue", {
      id: [id(SONGS.alpha), id(SONGS.bravo), id(SONGS.charlie)],
      current: id(SONGS.bravo),
      position: "12000",
      c: "Amperfy",
    });

    expect(body.status).toBe("ok");
    expect(body.error).toBeUndefined();
  });

  it("reads back the queue in order, with current, position and changedBy", async () => {
    const queue = await savedQueue();

    expect(titles(queue)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(queue.current).toBe(id(SONGS.bravo));
    expect(queue.position).toBe(12000);
    expect(queue.username).toBe(ADMIN);
    expect(queue.changedBy).toBe("Amperfy");
    expect(queue.changed).toBeTruthy();
    expect(new Date(queue.changed ?? "").getTime()).toBeGreaterThan(0);
  });

  it("carries the caller's annotation on each entry, as every read does", async () => {
    await call("star", { id: id(SONGS.alpha) });

    const queue = await savedQueue();
    const alpha = (queue.entry ?? []).find((entry) => entry.title === "Alpha");

    expect(alpha?.starred).toBeTruthy();
  });

  it("renders the queue in XML", async () => {
    const xml = await callXml("getPlayQueue");

    expect(xml).toContain('changedBy="Amperfy"');
    expect(xml).toContain('position="12000"');
    expect(xml).toContain(`current="${id(SONGS.bravo)}"`);
    expect(xml.indexOf('title="Alpha"')).toBeLessThan(xml.indexOf('title="Bravo"'));
    expect(xml.indexOf('title="Bravo"')).toBeLessThan(xml.indexOf('title="Charlie"'));
  });

  it("replaces the whole queue on the next save", async () => {
    await call("savePlayQueue", {
      id: [id(SONGS.delta), id(SONGS.alpha)],
      current: id(SONGS.delta),
      position: "500",
      c: "play:Sub",
    });

    const queue = await savedQueue();

    expect(titles(queue)).toEqual(["Delta", "Alpha"]);
    expect(queue.current).toBe(id(SONGS.delta));
    expect(queue.position).toBe(500);
    expect(queue.changedBy).toBe("play:Sub");
  });

  it("keeps a track the client queued twice", async () => {
    await call("savePlayQueue", { id: [id(SONGS.alpha), id(SONGS.bravo), id(SONGS.alpha)] });

    expect(titles(await savedQueue())).toEqual(["Alpha", "Bravo", "Alpha"]);
  });
});

describe("a track that has left the library", () => {
  it("is skipped rather than failing the response", async () => {
    await call("savePlayQueue", { id: [id(SONGS.alpha), id(SONGS.ghost), id(SONGS.bravo)] });

    await database(testEnv)
      .delete(track)
      .where(eq(track.id, trackId(SONGS.ghost.key)));

    const queue = await savedQueue();

    expect(titles(queue)).toEqual(["Alpha", "Bravo"]);
  });
});

describe("another user's queue", () => {
  it("is invisible to the caller, and theirs to them", async () => {
    await call("savePlayQueue", { id: [id(SONGS.charlie)] }, AS_OTHER);

    expect(titles(await savedQueue(AS_OTHER))).toEqual(["Charlie"]);
    expect((await savedQueue(AS_OTHER)).username).toBe(OTHER_USER);

    // The admin still sees the queue the admin saved.
    expect(titles(await savedQueue())).toEqual(["Alpha", "Bravo"]);
  });
});

describe("clearing the queue", () => {
  it("forgets it when the save names no track", async () => {
    const body = await call("savePlayQueue", {});
    expect(body.status).toBe("ok");

    expect(await savedQueue()).toEqual({});
  });

  it("leaves another user's queue alone", async () => {
    expect(titles(await savedQueue(AS_OTHER))).toEqual(["Charlie"]);
  });
});

describe("bad requests", () => {
  it("is error 70 for an id that is not a track id", async () => {
    const body = await call("savePlayQueue", { id: "not-an-id" });

    expect(body.error?.code).toBe(70);
  });

  it("is error 70 for a current that is not a track id", async () => {
    const body = await call("savePlayQueue", { id: id(SONGS.alpha), current: "al-nonsense" });

    expect(body.error?.code).toBe(70);
  });

  it("takes an unreadable position as 0, as Navidrome does", async () => {
    await call("savePlayQueue", { id: id(SONGS.alpha), position: "later" });

    expect((await savedQueue()).position).toBeUndefined();
  });

  it("refuses a queue longer than the cap, rather than saving one it cannot read back", async () => {
    const tooMany = Array.from({ length: 1001 }, (_, index) =>
      prefixedId("track", trackId(`${ARTIST}/${ALBUM}/never-${index}.mp3`)),
    );

    const body = await call("savePlayQueue", { id: tooMany });

    expect(body.error?.code).toBe(0);
    expect(body.error?.message).toContain("too many ids");
  });
});
