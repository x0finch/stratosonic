import { SELF } from "cloudflare:test";
import { albumId, artistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { type FixtureAlbum, fixtureCoverBytes, fixtures, fixtureTrack } from "./fixtures/files";
import {
  BASE,
  fixtureCoverKey,
  type JsonEnvelope,
  seedFixtureLibrary,
  seedFixtureObjects,
  testEnv,
} from "./support";

/**
 * `getCoverArt` against the Worker.
 *
 * The fixtures give this everything it needs: three albums with a cover and
 * one without, an artist with two albums to choose between, and the cover
 * objects themselves in the bucket under `_covers/<albumId>.png`.
 */

const USER = "admin";
const PASSWORD = "sesame";

function query(extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    u: USER,
    p: PASSWORD,
    v: "1.16.1",
    c: "Substreamer",
    ...extra,
  }).toString();
}

async function coverOf(id: string, extra: Record<string, string> = {}): Promise<Response> {
  return await SELF.fetch(`${BASE}/rest/getCoverArt?${query({ id, ...extra })}`);
}

async function bytesOf(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

async function errorOf(response: Response): Promise<{ code: number; message: string } | undefined> {
  const body = (await response.json()) as JsonEnvelope;

  return body["subsonic-response"].error;
}

/** The fixture album with this name; the manifest is the only source of it. */
function albumNamed(name: string): FixtureAlbum {
  const found = fixtures.albums.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`no fixture album named ${name}`);
  }

  return found;
}

function idOfAlbum(album: FixtureAlbum): string {
  return prefixedId("album", albumId(album.albumArtist, album.name, album.year));
}

/** An album with a cover, and one of its tracks. */
const COVERED = albumNamed("Quiet Album");
/** The album the fixtures give no cover, and its track and artist. */
const BARE = albumNamed("Fallback Album");

/** The artist with two covered albums, for the "which one?" rule. */
const TWO_ALBUM_ARTIST = "Mute Ensemble";

beforeAll(async () => {
  await SELF.fetch(`${BASE}/rest/ping`);
  await seedFixtureLibrary();
  await seedFixtureObjects();
});

describe("getCoverArt", () => {
  it.each(["/rest/getCoverArt", "/rest/getCoverArt.view"])(
    "serves the album's cover on %s",
    async (path) => {
      const response = await SELF.fetch(`${BASE}${path}?${query({ id: idOfAlbum(COVERED) })}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/png");
      expect(await bytesOf(response)).toEqual(fixtureCoverBytes());
    },
  );

  it("describes the image it serves", async () => {
    const response = await coverOf(idOfAlbum(COVERED));

    expect(response.headers.get("Content-Length")).toBe(String(fixtureCoverBytes().length));
    expect(response.headers.get("ETag")).toMatch(/^"[0-9a-f]+"$/);
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
  });

  it("serves a track's cover: the one its album carries", async () => {
    const file = COVERED.trackFiles[0];
    if (file === undefined) {
      throw new Error("the covered fixture album has no tracks");
    }

    const id = prefixedId("track", trackId(fixtureTrack(file).r2Key));
    const response = await coverOf(id);

    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(await bytesOf(response)).toEqual(fixtureCoverBytes());
  });

  it("serves an artist's cover: the first of its albums that has one", async () => {
    const response = await coverOf(prefixedId("artist", artistId(TWO_ALBUM_ARTIST)));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(await bytesOf(response)).toEqual(fixtureCoverBytes());
  });

  // The rule, stated once: of the albums an artist has, the first by name and
  // then by year. "Faststart Sessions" sorts before "Trailing Sessions".
  it("borrows the artist's cover from the album that sorts first", async () => {
    const response = await coverOf(prefixedId("artist", artistId(TWO_ALBUM_ARTIST)));
    const expected = await testEnv.MUSIC.head(
      fixtureCoverKey(albumNamed("Faststart Sessions")) ?? "",
    );

    expect(response.headers.get("ETag")).toBe(expected?.httpEtag);
  });

  it("accepts size and serves the stored cover unchanged", async () => {
    const response = await coverOf(idOfAlbum(COVERED), { size: "300" });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(await bytesOf(response)).toEqual(fixtureCoverBytes());
  });

  it("recognises the image from its bytes when nothing was stored with it", async () => {
    // The seeds write the cover objects without an httpMetadata content type,
    // as rclone would; every PNG above was therefore recognised by its
    // signature rather than by what R2 remembered.
    const key = fixtureCoverKey(COVERED);
    const stored = key === null ? null : await testEnv.MUSIC.head(key);

    expect(stored?.httpMetadata?.contentType).toBeUndefined();
  });

  it("serves a range of the cover, for a client that asks for one", async () => {
    const response = await coverOf(idOfAlbum(COVERED), {});
    const whole = await bytesOf(response);
    const partial = await SELF.fetch(
      `${BASE}/rest/getCoverArt?${query({ id: idOfAlbum(COVERED) })}`,
      { headers: { Range: "bytes=0-7" } },
    );

    expect(partial.status).toBe(206);
    expect(await bytesOf(partial)).toEqual(whole.slice(0, 8));
  });
});

describe("getCoverArt without an image to serve", () => {
  it("answers error 70 for an album whose tracks carried no cover", async () => {
    const response = await coverOf(idOfAlbum(BARE), { f: "json" });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(await errorOf(response)).toEqual({ code: 70, message: "Artwork not found" });
  });

  it("answers error 70 for a track of that album", async () => {
    const file = BARE.trackFiles[0];
    if (file === undefined) {
      throw new Error("the cover-less fixture album has no tracks");
    }

    const id = prefixedId("track", trackId(fixtureTrack(file).r2Key));

    expect((await errorOf(await coverOf(id, { f: "json" })))?.code).toBe(70);
  });

  it("answers error 70 for its artist, who has no other album to borrow from", async () => {
    const id = prefixedId("artist", artistId(BARE.albumArtist));

    expect((await errorOf(await coverOf(id, { f: "json" })))?.code).toBe(70);
  });

  it("answers error 70 for an id no album, track or artist has", async () => {
    const id = prefixedId("album", albumId("Nobody", "Nothing", 1999));

    expect((await errorOf(await coverOf(id, { f: "json" })))?.code).toBe(70);
  });

  it("answers error 70 for a playlist id, which names no artwork", async () => {
    const id = prefixedId("playlist", trackId("playlists/favourites.m3u"));

    expect((await errorOf(await coverOf(id, { f: "json" })))?.code).toBe(70);
  });

  it("answers error 70 for an id this server could never have minted", async () => {
    expect((await errorOf(await coverOf("al-nonsense", { f: "json" })))?.code).toBe(70);
  });

  it("answers error 10 when no id is given", async () => {
    const response = await SELF.fetch(`${BASE}/rest/getCoverArt?${query({ f: "json" })}`);

    expect(await errorOf(response)).toEqual({ code: 10, message: "missing parameter: 'id'" });
  });

  it("answers error 40 to a caller who does not authenticate", async () => {
    const params = new URLSearchParams({
      u: USER,
      p: "wrong",
      v: "1.16.1",
      c: "Substreamer",
      id: idOfAlbum(COVERED),
      f: "json",
    });
    const response = await SELF.fetch(`${BASE}/rest/getCoverArt?${params.toString()}`);

    expect((await errorOf(response))?.code).toBe(40);
  });
});
