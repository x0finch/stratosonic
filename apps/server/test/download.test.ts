import { SELF } from "cloudflare:test";
import { prefixedId, type Track, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { fixtureBytes, fixtureTrack } from "./fixtures/files";
import {
  BASE,
  type JsonEnvelope,
  seedFixtureLibrary,
  seedFixtureObjects,
  seedTrack,
  testEnv,
} from "./support";

/**
 * `download` against the Worker. It serves what `stream` serves — the same
 * object, the same ranges — and adds the name the client should save it as,
 * so these tests are about that name and about the bytes still being right.
 */

const USER = "admin";
const PASSWORD = "sesame";

const MP3 = "silent-track.mp3";

/** A track whose file name needs more than a quoted string can carry. */
const ACCENTED_KEY = "Chanteuse Diligente/Été Sonore/01 Café Après-midi.mp3";
const ACCENTED_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);

function query(extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    u: USER,
    p: PASSWORD,
    v: "1.16.1",
    c: "Substreamer",
    ...extra,
  }).toString();
}

function idOf(file: string): string {
  return prefixedId("track", trackId(fixtureTrack(file).r2Key));
}

async function downloadOf(id: string, range?: string): Promise<Response> {
  return await SELF.fetch(`${BASE}/rest/download?${query({ id })}`, {
    headers: range === undefined ? undefined : { Range: range },
  });
}

async function bytesOf(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

let accented: Track;

beforeAll(async () => {
  await SELF.fetch(`${BASE}/rest/ping`);
  await seedFixtureLibrary();
  await seedFixtureObjects();

  accented = await seedTrack({ r2Key: ACCENTED_KEY });
  await testEnv.MUSIC.put(ACCENTED_KEY, ACCENTED_BYTES);
});

describe("download", () => {
  it.each(["/rest/download", "/rest/download.view"])(
    "serves the original bytes on %s",
    async (path) => {
      const response = await SELF.fetch(`${BASE}${path}?${query({ id: idOf(MP3) })}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
      expect(response.headers.get("Content-Length")).toBe(String(fixtureTrack(MP3).size));
      expect(await bytesOf(response)).toEqual(fixtureBytes(MP3));
    },
  );

  it("names the file the client should save, from the R2 key", async () => {
    const response = await downloadOf(idOf(MP3));

    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="01 Silent Track.mp3"',
    );
  });

  it("carries a name with accents in the encoded parameter too", async () => {
    const response = await SELF.fetch(
      `${BASE}/rest/download?${query({ id: prefixedId("track", accented.id) })}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="01 Caf_ Apr_s-midi.mp3"; ' +
        "filename*=UTF-8''01%20Caf%C3%A9%20Apr%C3%A8s-midi.mp3",
    );
    expect(await bytesOf(response)).toEqual(ACCENTED_BYTES);
  });

  it("honours a Range as stream does, and still names the file", async () => {
    const response = await downloadOf(idOf(MP3), "bytes=0-9");

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 0-9/${fixtureTrack(MP3).size}`);
    expect(response.headers.get("Content-Disposition")).toContain("attachment;");
    expect(await bytesOf(response)).toEqual(fixtureBytes(MP3).slice(0, 10));
  });

  it("refuses an unsatisfiable range without a body", async () => {
    const { size } = fixtureTrack(MP3);
    const response = await downloadOf(idOf(MP3), `bytes=${size}-`);

    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe(`bytes */${size}`);
  });

  it("answers error 70 for an id no track has", async () => {
    const unknown = prefixedId("track", trackId("nothing/at/all.mp3"));
    const response = await SELF.fetch(`${BASE}/rest/download?${query({ id: unknown, f: "json" })}`);
    const body = (await response.json()) as JsonEnvelope;

    expect(body["subsonic-response"].error?.code).toBe(70);
  });

  it("answers error 10 when no id is given", async () => {
    const response = await SELF.fetch(`${BASE}/rest/download?${query({ f: "json" })}`);
    const body = (await response.json()) as JsonEnvelope;

    expect(body["subsonic-response"].error?.code).toBe(10);
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
    const response = await SELF.fetch(`${BASE}/rest/download?${params.toString()}`);
    const body = (await response.json()) as JsonEnvelope;

    expect(body["subsonic-response"].error?.code).toBe(40);
  });
});
