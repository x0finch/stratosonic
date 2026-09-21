import { SELF } from "cloudflare:test";
import { prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { ADMIN, bootstrapAdmin, type SubsonicSongElement } from "./browsing-support";
import { BASE, seedAlbum, seedArtist, seedTrack, seedUser } from "./support";

/**
 * `createBookmark`, `getBookmarks` and `deleteBookmark`: a listener marks
 * where they stopped in a long track and any client can offer to resume
 * there.
 *
 * The whole round trip is driven over HTTP — create, read back, delete, read
 * back — because what one client writes is what another client is handed.
 */

const ARTIST = "Cassiopeia";
const ALBUM = "Schedar";
const YEAR = 2021;

interface Song {
  readonly key: string;
  readonly title: string;
}

const SONGS = {
  mix: { key: `${ARTIST}/${ALBUM}/01 Long Mix.mp3`, title: "Long Mix" },
  talk: { key: `${ARTIST}/${ALBUM}/02 Long Talk.mp3`, title: "Long Talk" },
  other: { key: `${ARTIST}/${ALBUM}/03 Other.mp3`, title: "Other" },
} satisfies Record<string, Song>;

const id = (song: Song) => prefixedId("track", trackId(song.key));

const PASSWORD = "sesame";
const OTHER_USER = "guest";
const OTHER_PASSWORD = "open-sesame";

interface Credentials {
  readonly user: string;
  readonly password: string;
}

const AS_ADMIN: Credentials = { user: ADMIN, password: PASSWORD };
const AS_OTHER: Credentials = { user: OTHER_USER, password: OTHER_PASSWORD };

/** `<bookmark>` as the JSON rendering carries it. */
interface BookmarkElement {
  entry: SubsonicSongElement;
  position: number;
  username: string;
  comment: string;
  created: string;
  changed: string;
}

interface Envelope {
  status: string;
  error?: { code: number; message: string };
  bookmarks?: { bookmark?: BookmarkElement[] };
}

function query(extra: Record<string, string> = {}, credentials: Credentials = AS_ADMIN): string {
  return new URLSearchParams({
    u: credentials.user,
    p: credentials.password,
    v: "1.16.1",
    c: "Substreamer",
    ...extra,
  }).toString();
}

async function call(
  endpoint: string,
  extra: Record<string, string> = {},
  credentials?: Credentials,
): Promise<Envelope> {
  const response = await SELF.fetch(
    `${BASE}/rest/${endpoint}?${query({ ...extra, f: "json" }, credentials)}`,
  );
  const body = (await response.json()) as { "subsonic-response": Envelope };

  return body["subsonic-response"];
}

async function callXml(endpoint: string, extra: Record<string, string> = {}): Promise<string> {
  return (await SELF.fetch(`${BASE}/rest/${endpoint}?${query(extra)}`)).text();
}

/** The caller's bookmarks, as `getBookmarks` answers with them. */
async function bookmarks(credentials?: Credentials): Promise<BookmarkElement[]> {
  const body = await call("getBookmarks", {}, credentials);
  expect(body.status).toBe("ok");

  return body.bookmarks?.bookmark ?? [];
}

/** The caller's bookmark on one song, or undefined when there is none. */
async function bookmarkOf(song: Song, credentials?: Credentials) {
  return (await bookmarks(credentials)).find((entry) => entry.entry.id === id(song));
}

beforeAll(async () => {
  await bootstrapAdmin();
  await seedUser(OTHER_USER, OTHER_PASSWORD);
  await seedArtist({ name: ARTIST });
  await seedAlbum({ name: ALBUM, albumArtist: ARTIST, year: YEAR, songCount: 3 });
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

describe("a caller with no bookmarks", () => {
  it("gets an empty bookmarks container", async () => {
    const body = await call("getBookmarks");

    expect(body.status).toBe("ok");
    expect(body.bookmarks).toEqual({});
  });

  it("gets an empty bookmarks element in XML", async () => {
    const xml = await callXml("getBookmarks");

    expect(xml).toContain('status="ok"');
    expect(xml).toContain("<bookmarks/>");
  });
});

describe("creating a bookmark", () => {
  it("answers with an empty ok envelope", async () => {
    const body = await call("createBookmark", {
      id: id(SONGS.mix),
      position: "90000",
      comment: "here",
    });

    expect(body.status).toBe("ok");
    expect(body.error).toBeUndefined();
  });

  it("lists it with the song, the position, the comment and the timestamps", async () => {
    const bookmark = await bookmarkOf(SONGS.mix);

    expect(bookmark?.position).toBe(90000);
    expect(bookmark?.comment).toBe("here");
    expect(bookmark?.username).toBe(ADMIN);
    expect(bookmark?.entry.title).toBe("Long Mix");
    expect(bookmark?.entry.album).toBe(ALBUM);
    expect(new Date(bookmark?.created ?? "").getTime()).toBeGreaterThan(0);
    expect(new Date(bookmark?.changed ?? "").getTime()).toBeGreaterThan(0);
  });

  it("renders the bookmark and its entry in XML", async () => {
    const xml = await callXml("getBookmarks");

    expect(xml).toContain('position="90000"');
    expect(xml).toContain('comment="here"');
    expect(xml).toContain(`username="${ADMIN}"`);
    expect(xml).toContain("<bookmark ");
    expect(xml).toContain('<entry id="');
  });

  it("keeps created and moves position, comment and changed on a second create", async () => {
    const before = await bookmarkOf(SONGS.mix);

    await call("createBookmark", { id: id(SONGS.mix), position: "120000", comment: "further" });

    const after = await bookmarkOf(SONGS.mix);

    expect((await bookmarks()).length).toBe(1);
    expect(after?.position).toBe(120000);
    expect(after?.comment).toBe("further");
    expect(after?.created).toBe(before?.created);
    expect(new Date(after?.changed ?? "").getTime()).toBeGreaterThanOrEqual(
      new Date(before?.changed ?? "").getTime(),
    );
  });

  it("takes no comment as an empty one", async () => {
    await call("createBookmark", { id: id(SONGS.talk), position: "1000" });

    expect((await bookmarkOf(SONGS.talk))?.comment).toBe("");
  });
});

describe("another user's bookmarks", () => {
  it("are invisible to the caller, and theirs to them", async () => {
    await call("createBookmark", { id: id(SONGS.other), position: "42" }, AS_OTHER);

    const theirs = await bookmarks(AS_OTHER);
    expect(theirs.map((entry) => entry.entry.title)).toEqual(["Other"]);
    expect(theirs[0]?.username).toBe(OTHER_USER);

    expect((await bookmarks()).map((entry) => entry.entry.title)).not.toContain("Other");
  });
});

describe("deleting a bookmark", () => {
  it("removes it and leaves the caller's others", async () => {
    const body = await call("deleteBookmark", { id: id(SONGS.mix) });
    expect(body.status).toBe("ok");

    expect(await bookmarkOf(SONGS.mix)).toBeUndefined();
    expect(await bookmarkOf(SONGS.talk)).toBeDefined();
  });

  it("leaves another user's bookmark on the same track alone", async () => {
    await call("createBookmark", { id: id(SONGS.talk), position: "7" }, AS_OTHER);
    await call("deleteBookmark", { id: id(SONGS.talk) });

    expect(await bookmarkOf(SONGS.talk)).toBeUndefined();
    expect((await bookmarkOf(SONGS.talk, AS_OTHER))?.position).toBe(7);
  });

  it("is error 70 for a bookmark the caller does not have", async () => {
    const body = await call("deleteBookmark", { id: id(SONGS.mix) });

    expect(body.error?.code).toBe(70);
  });
});

describe("bad requests", () => {
  it("is error 10 when createBookmark has no id", async () => {
    expect((await call("createBookmark", { position: "1" })).error?.code).toBe(10);
  });

  it("is error 10 when createBookmark has no position", async () => {
    expect((await call("createBookmark", { id: id(SONGS.mix) })).error?.code).toBe(10);
  });

  it("is error 10 when deleteBookmark has no id", async () => {
    expect((await call("deleteBookmark", {})).error?.code).toBe(10);
  });

  it("is error 70 for an id that names no track", async () => {
    const body = await call("createBookmark", {
      id: prefixedId("track", trackId("Ghost/None/x.mp3")),
      position: "1",
    });

    expect(body.error?.code).toBe(70);
  });

  it("is error 70 for an id that is not a track id", async () => {
    expect((await call("createBookmark", { id: "not-an-id", position: "1" })).error?.code).toBe(70);
  });
});
