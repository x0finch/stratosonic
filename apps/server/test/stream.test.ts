import { SELF } from "cloudflare:test";
import { albumId, prefixedId, type Track, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { fixtureBytes, fixtures, fixtureTrack } from "./fixtures/files";
import {
  BASE,
  type JsonEnvelope,
  seedFixtureLibrary,
  seedFixtureObjects,
  seedTrack,
  testEnv,
} from "./support";

/**
 * `stream` against the Worker: the fixtures are seeded into D1 and into the
 * miniflare bucket, and every assertion is about what a client receives.
 *
 * The bytes are the fixtures' own, so "the original file" is a claim these
 * tests can check rather than restate.
 */

const USER = "admin";
const PASSWORD = "sesame";

/** The MP3 fixture, whose 3598 bytes make the ranges below meaningful. */
const MP3 = "silent-track.mp3";
/** The FLAC fixture, for the "asked for mp3, given the original" case. */
const FLAC = "hushed-interlude.flac";
/** The M4A fixture, for the same case in the other format. */
const M4A = "front-loaded.m4a";

/** A track whose row exists but whose object was never written to R2. */
const ABSENT_KEY = "Silent Artist/Quiet Album/03 Never Uploaded.mp3";

function query(extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    u: USER,
    p: PASSWORD,
    v: "1.16.1",
    c: "Substreamer",
    ...extra,
  }).toString();
}

/** The id a client streams a fixture by. */
function idOf(file: string): string {
  return prefixedId("track", trackId(fixtureTrack(file).r2Key));
}

async function streamOf(
  id: string,
  { range, method = "GET", extra = {} }: StreamOptions = {},
): Promise<Response> {
  return await SELF.fetch(`${BASE}/rest/stream?${query({ id, ...extra })}`, {
    method,
    headers: range === undefined ? undefined : { Range: range },
  });
}

interface StreamOptions {
  readonly range?: string;
  readonly method?: string;
  readonly extra?: Record<string, string>;
}

async function bytesOf(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

/** The failure a response carries, read as JSON. */
async function errorOf(response: Response): Promise<{ code: number; message: string } | undefined> {
  const body = (await response.json()) as JsonEnvelope;

  return body["subsonic-response"].error;
}

let absent: Track;

beforeAll(async () => {
  // The bootstrap admin is created by the first request the Worker serves.
  await SELF.fetch(`${BASE}/rest/ping`);
  await seedFixtureLibrary();
  await seedFixtureObjects();
  absent = await seedTrack({ r2Key: ABSENT_KEY });
});

describe("stream", () => {
  it.each(["/rest/stream", "/rest/stream.view"])("serves the whole track on %s", async (path) => {
    const id = idOf(MP3);
    const response = await SELF.fetch(`${BASE}${path}?${query({ id })}`);

    expect(response.status).toBe(200);
    expect(await bytesOf(response)).toEqual(fixtureBytes(MP3));
  });

  it("describes the whole track it serves", async () => {
    const response = await streamOf(idOf(MP3));
    const { size } = fixtureTrack(MP3);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(size));
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("ETag")).toMatch(/^"[0-9a-f]+"$/);
    expect(response.headers.get("Content-Range")).toBeNull();
  });

  it("serves each format with the content type its suffix names", async () => {
    expect((await streamOf(idOf(FLAC))).headers.get("Content-Type")).toBe("audio/flac");
    expect((await streamOf(idOf(M4A))).headers.get("Content-Type")).toBe("audio/mp4");
  });

  it("serves the first two bytes of bytes=0-1", async () => {
    const response = await streamOf(idOf(MP3), { range: "bytes=0-1" });
    const { size } = fixtureTrack(MP3);

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 0-1/${size}`);
    expect(response.headers.get("Content-Length")).toBe("2");
    expect(await bytesOf(response)).toEqual(fixtureBytes(MP3).slice(0, 2));
  });

  it("serves an open range to the end of the track", async () => {
    const response = await streamOf(idOf(MP3), { range: "bytes=100-" });
    const { size } = fixtureTrack(MP3);

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 100-${size - 1}/${size}`);
    expect(response.headers.get("Content-Length")).toBe(String(size - 100));
    expect(await bytesOf(response)).toEqual(fixtureBytes(MP3).slice(100));
  });

  it("serves a suffix range of the last bytes", async () => {
    const response = await streamOf(idOf(MP3), { range: "bytes=-500" });
    const { size } = fixtureTrack(MP3);

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes ${size - 500}-${size - 1}/${size}`);
    expect(await bytesOf(response)).toEqual(fixtureBytes(MP3).slice(size - 500));
  });

  it("clamps a suffix range larger than the track to the whole track", async () => {
    const { size } = fixtureTrack(FLAC);
    const response = await streamOf(idOf(FLAC), { range: `bytes=-${size + 1000}` });

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 0-${size - 1}/${size}`);
    expect(await bytesOf(response)).toEqual(fixtureBytes(FLAC));
  });

  // Decided here: bytes=0- is a satisfiable range, so it is answered as a
  // partial response covering the whole track rather than as a plain 200.
  it("answers bytes=0- with the whole track as a partial response", async () => {
    const response = await streamOf(idOf(MP3), { range: "bytes=0-" });
    const { size } = fixtureTrack(MP3);

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 0-${size - 1}/${size}`);
    expect(response.headers.get("Content-Length")).toBe(String(size));
    expect(await bytesOf(response)).toEqual(fixtureBytes(MP3));
  });

  it("refuses a range that starts past the end of the track", async () => {
    const { size } = fixtureTrack(MP3);
    const response = await streamOf(idOf(MP3), { range: `bytes=${size}-${size + 10}` });

    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe(`bytes */${size}`);
    expect(await bytesOf(response)).toEqual(new Uint8Array());
  });

  it.each(["bytes=abc", "bytes=", "items=0-1", "bytes=0-1,4-5"])(
    "serves the whole track for the malformed range %s",
    async (range) => {
      const response = await streamOf(idOf(MP3), { range });

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Range")).toBeNull();
      expect(await bytesOf(response)).toEqual(fixtureBytes(MP3));
    },
  );

  it("answers a HEAD with the headers and no body", async () => {
    const response = await streamOf(idOf(MP3), { method: "HEAD" });
    const { size } = fixtureTrack(MP3);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(size));
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(await bytesOf(response)).toEqual(new Uint8Array());
  });

  it("answers a HEAD with a range the same way, without a body", async () => {
    const response = await streamOf(idOf(MP3), { method: "HEAD", range: "bytes=0-1" });

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 0-1/${fixtureTrack(MP3).size}`);
    expect(await bytesOf(response)).toEqual(new Uint8Array());
  });
});

describe("stream and the transcoding parameters", () => {
  // ADR-0001: no transcoding. A client asking for mp3 gets the FLAC it asked
  // about, labelled as what it is, and plays it.
  it.each([FLAC, M4A])("serves %s unchanged when the client asks for mp3", async (file) => {
    const extra = { format: "mp3", maxBitRate: "64", timeOffset: "30" };
    const response = await streamOf(idOf(file), { extra });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(fixtureTrack(file).contentType);
    expect(await bytesOf(response)).toEqual(fixtureBytes(file));
  });

  it("serves the original bytes for a range too", async () => {
    const extra = { format: "mp3", estimateContentLength: "true" };
    const response = await streamOf(idOf(FLAC), { range: "bytes=0-9", extra });

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Type")).toBe("audio/flac");
    expect(await bytesOf(response)).toEqual(fixtureBytes(FLAC).slice(0, 10));
  });
});

describe("stream without a track to serve", () => {
  it("answers error 70 when the track's object is gone from the bucket", async () => {
    const response = await streamOf(prefixedId("track", absent.id), { extra: { f: "json" } });

    expect(response.status).toBe(200);
    expect(await errorOf(response)).toEqual({
      code: 70,
      message: "The requested data was not found",
    });
  });

  it("answers error 70 for an id no track has", async () => {
    const unknown = prefixedId("track", trackId("nothing/at/all.mp3"));
    const response = await streamOf(unknown, { extra: { f: "json" } });

    expect((await errorOf(response))?.code).toBe(70);
  });

  it("answers error 70 for an album id", async () => {
    const album = fixtures.albums[0];
    if (album === undefined) {
      throw new Error("the fixtures describe no albums");
    }

    const id = prefixedId("album", albumId(album.albumArtist, album.name, album.year));
    const response = await streamOf(id, { extra: { f: "json" } });

    expect((await errorOf(response))?.code).toBe(70);
  });

  it("answers error 70 for an id that is not one this server could mint", async () => {
    const response = await streamOf("tr-not-an-id", { extra: { f: "json" } });

    expect((await errorOf(response))?.code).toBe(70);
  });

  it("answers error 10 when no id is given", async () => {
    const response = await SELF.fetch(`${BASE}/rest/stream?${query({ f: "json" })}`);

    expect(await errorOf(response)).toEqual({ code: 10, message: "missing parameter: 'id'" });
  });

  it("answers error 40 to a caller who does not authenticate", async () => {
    const params = new URLSearchParams({
      u: USER,
      p: "wrong",
      v: "1.16.1",
      c: "Substreamer",
      id: idOf(MP3),
      f: "json",
    });
    const response = await SELF.fetch(`${BASE}/rest/stream?${params.toString()}`);

    expect((await errorOf(response))?.code).toBe(40);
  });

  it("does not read the object for a caller it refuses", async () => {
    // Belt and braces: the refusal is an envelope, never the track's bytes.
    const params = new URLSearchParams({ u: USER, v: "1.16.1", c: "x", id: idOf(MP3) });
    const response = await SELF.fetch(`${BASE}/rest/stream?${params.toString()}`);

    expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(await response.text()).toContain('status="failed"');
  });
});

describe("the seeded bucket", () => {
  it("holds every fixture the library knows about", async () => {
    for (const fixture of fixtures.tracks) {
      const object = await testEnv.MUSIC.head(fixture.r2Key);

      expect(object?.size).toBe(fixture.size);
    }
  });
});
