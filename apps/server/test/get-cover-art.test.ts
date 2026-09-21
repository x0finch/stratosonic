import { SELF } from "cloudflare:test";
import { albumId, artistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { sniffImageType } from "../src/media/images";
import { type FixtureAlbum, fixtureCoverBytes, fixtures, fixtureTrack } from "./fixtures/files";
import {
  BASE,
  fixtureCoverKey,
  type JsonEnvelope,
  seedAlbum,
  seedArtist,
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

/** An album named by the three things its id is derived from. */
interface NamedAlbum {
  readonly name: string;
  readonly albumArtist: string;
  readonly year: number | null;
}

function idOfAlbum(album: NamedAlbum): string {
  return prefixedId("album", albumId(album.albumArtist, album.name, album.year));
}

function coverKeyOf(album: NamedAlbum, extension: string): string {
  return `_covers/${albumId(album.albumArtist, album.name, album.year)}.${extension}`;
}

/** An album with a cover, and one of its tracks. */
const COVERED = albumNamed("Quiet Album");
/** The album the fixtures give no cover, and its track and artist. */
const BARE = albumNamed("Fallback Album");

/** The artist with two covered albums, for the "which one?" rule. */
const TWO_ALBUM_ARTIST = "Mute Ensemble";

/** An album whose cover object carries the content type it was written with. */
const LABELLED: NamedAlbum = { name: "Labelled Sleeve", albumArtist: "Studio Marker", year: 2020 };
const LABELLED_TYPE = "image/jpeg";
const LABELLED_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/** An album whose cover object is there, and empty: nothing to recognise. */
const EMPTY: NamedAlbum = { name: "Empty Sleeve", albumArtist: "Blank Studio", year: 2021 };

/**
 * An artist whose two covered albums disagree about which comes first: the
 * older one is the later one alphabetically, so only the year can decide.
 */
const CHRONOLOGIST = "Chrono Ensemble";
const OLDER: NamedAlbum = { name: "Zeta Beginnings", albumArtist: CHRONOLOGIST, year: 1999 };
const NEWER: NamedAlbum = { name: "Alpha Afterwards", albumArtist: CHRONOLOGIST, year: 2020 };

/** An artist one of whose albums has no year at all. */
const UNDATED_ARTIST = "Timeless Trio";
const UNDATED: NamedAlbum = { name: "Zeta Undated", albumArtist: UNDATED_ARTIST, year: null };
const DATED: NamedAlbum = { name: "Alpha Dated", albumArtist: UNDATED_ARTIST, year: 1980 };

/** A PNG apiece, so which cover was served is visible in the bytes. */
function pngOf(marker: number): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker]);
}

const OLDER_COVER = pngOf(0x01);
const NEWER_COVER = pngOf(0x02);
const UNDATED_COVER = pngOf(0x03);
const DATED_COVER = pngOf(0x04);

beforeAll(async () => {
  await SELF.fetch(`${BASE}/rest/ping`);
  await seedFixtureLibrary();
  await seedFixtureObjects();

  const labelledKey = coverKeyOf(LABELLED, "jpg");
  await seedAlbum({ ...LABELLED, coverKey: labelledKey });
  await testEnv.MUSIC.put(labelledKey, LABELLED_BYTES, {
    httpMetadata: { contentType: LABELLED_TYPE },
  });

  const emptyKey = coverKeyOf(EMPTY, "png");
  await seedAlbum({ ...EMPTY, coverKey: emptyKey });
  await testEnv.MUSIC.put(emptyKey, new Uint8Array());

  // The artists whose covers are borrowed need rows of their own: an artist's
  // cover is resolved through the artist, as `getArtist` resolves it.
  await seedArtist({ name: CHRONOLOGIST });
  await seedArtist({ name: UNDATED_ARTIST });

  for (const [album, bytes] of [
    [OLDER, OLDER_COVER],
    [NEWER, NEWER_COVER],
    [UNDATED, UNDATED_COVER],
    [DATED, DATED_COVER],
  ] as const) {
    const key = coverKeyOf(album, "png");
    await seedAlbum({ ...album, coverKey: key });
    await testEnv.MUSIC.put(key, bytes);
  }
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

  // The rule, stated once: of the albums an artist has, the first by year,
  // then by name — Navidrome's `max_year` sort, which `getArtist` lists an
  // artist's albums in. The two fixture albums share a year, so the name
  // decides: "Faststart Sessions" before "Trailing Sessions".
  it("borrows the artist's cover from the album that sorts first", async () => {
    const response = await coverOf(prefixedId("artist", artistId(TWO_ALBUM_ARTIST)));
    const expected = await testEnv.MUSIC.head(
      fixtureCoverKey(albumNamed("Faststart Sessions")) ?? "",
    );

    expect(response.headers.get("ETag")).toBe(expected?.httpEtag);
  });

  it("borrows it from the oldest album, not the first one alphabetically", async () => {
    const response = await coverOf(prefixedId("artist", artistId(CHRONOLOGIST)));

    expect(response.status).toBe(200);
    expect(await bytesOf(response)).toEqual(OLDER_COVER);
  });

  it("counts an album whose year is unknown as the oldest of them", async () => {
    const response = await coverOf(prefixedId("artist", artistId(UNDATED_ARTIST)));

    expect(await bytesOf(response)).toEqual(UNDATED_COVER);
  });

  it("accepts size and serves the stored cover unchanged", async () => {
    const response = await coverOf(idOfAlbum(COVERED), { size: "300" });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(await bytesOf(response)).toEqual(fixtureCoverBytes());
  });

  it("has nothing but the bytes to go on: the seeded covers store no type", async () => {
    // The seeds write the cover objects without an httpMetadata content type,
    // as rclone would; every "image/png" above was therefore recognised by
    // the signature rather than read back from R2.
    const key = fixtureCoverKey(COVERED);
    const stored = key === null ? null : await testEnv.MUSIC.head(key);

    expect(stored?.httpMetadata?.contentType).toBeUndefined();
  });

  it("prefers the content type the object was stored with", async () => {
    const response = await coverOf(idOfAlbum(LABELLED));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(LABELLED_TYPE);
  });

  it("serves an empty cover object as bytes rather than reading a signature", async () => {
    // R2 refuses a range that reaches past an object's end, and an empty
    // object has no first bytes to read — so nothing is read at all.
    const response = await coverOf(idOfAlbum(EMPTY));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Length")).toBe("0");
    expect(await bytesOf(response)).toEqual(new Uint8Array());
  });

  it("answers a HEAD without reading the image", async () => {
    // The seeded cover stores no content type, and a HEAD does not read the
    // signature that would supply one — a request carrying no image must not
    // cost a second R2 operation. So it is told what the object itself says.
    const response = await SELF.fetch(
      `${BASE}/rest/getCoverArt?${query({ id: idOfAlbum(COVERED) })}`,
      { method: "HEAD" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Length")).toBe(String(fixtureCoverBytes().length));
    expect(await bytesOf(response)).toEqual(new Uint8Array());
  });

  it("answers a HEAD with the stored type when the object carries one", async () => {
    const response = await SELF.fetch(
      `${BASE}/rest/getCoverArt?${query({ id: idOfAlbum(LABELLED) })}`,
      { method: "HEAD" },
    );

    expect(response.headers.get("Content-Type")).toBe(LABELLED_TYPE);
    expect(await bytesOf(response)).toEqual(new Uint8Array());
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

describe("the image a cover's first bytes name", () => {
  function bytes(...values: number[]): Uint8Array {
    return new Uint8Array(values);
  }

  function ascii(text: string, ...rest: number[]): Uint8Array {
    return new Uint8Array([...[...text].map((character) => character.charCodeAt(0)), ...rest]);
  }

  it("recognises the PNG the fixtures use", () => {
    expect(sniffImageType(fixtureCoverBytes())).toBe("image/png");
  });

  it("recognises a JPEG", () => {
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toBe("image/jpeg");
  });

  it("recognises a GIF", () => {
    expect(sniffImageType(ascii("GIF89a"))).toBe("image/gif");
  });

  it("recognises a WebP, whose marker sits after the file's length", () => {
    expect(sniffImageType(ascii("RIFF\u0010\u0000\u0000\u0000WEBPVP8 "))).toBe("image/webp");
  });

  it("does not call something an image on the strength of a few bytes", () => {
    expect(sniffImageType(ascii("ID3\u0004"))).toBe("application/octet-stream");
    expect(sniffImageType(ascii("RIFF\u0010\u0000\u0000\u0000WAVE"))).toBe(
      "application/octet-stream",
    );
    expect(sniffImageType(bytes())).toBe("application/octet-stream");
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
