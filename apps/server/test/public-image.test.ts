import { SELF } from "cloudflare:test";
import { albumId, artistId, prefixedId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { signPublicImageToken, verifyPublicImageToken } from "../src/auth/public-token";
import type { Env } from "../src/env";
import { sniffImageType } from "../src/media/images";
import { publicImageToken } from "./info-support";
import { type RecordedWrite, recordingDatabase } from "./playlists-support";
import { BASE, encryptionKey, seedFixtureLibrary, seedFixtureObjects, testEnv } from "./support";

/**
 * `GET /share/img/<token>`: the public image URL the info endpoints hand out,
 * as Navidrome's `handleImages` serves it (server/public/handle_images.go).
 * No Subsonic credentials; the token authorizes one cover and nothing else.
 */

const QUIET = prefixedId("album", albumId("Silent Artist", "Quiet Album", 2001));
const FALLBACK = prefixedId("album", albumId("Fallback Artist", "Fallback Album", null));
const SILENT = prefixedId("artist", artistId("Silent Artist"));

function base64Url(text: string): string {
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Fetches a public image path through the app with a D1 that records every statement. */
async function counted(path: string): Promise<{ response: Response; statements: RecordedWrite[] }> {
  const statements: RecordedWrite[] = [];
  const env: Env = { ...testEnv, DB: recordingDatabase(statements) };
  const response = await createApp().fetch(new Request(`${BASE}${path}`), env);

  return { response, statements };
}

beforeAll(async () => {
  await seedFixtureLibrary();
  await seedFixtureObjects();
});

describe("public image tokens", () => {
  it("verify as the id they were signed for", async () => {
    const token = await signPublicImageToken(encryptionKey(), QUIET);

    expect(await verifyPublicImageToken(encryptionKey(), token)).toBe(QUIET);
  });

  it("do not verify for another id carrying the same MAC", async () => {
    const [, mac] = (await signPublicImageToken(encryptionKey(), QUIET)).split(".");

    expect(await verifyPublicImageToken(encryptionKey(), `${base64Url(FALLBACK)}.${mac}`)).toBe(
      null,
    );
  });

  it("do not verify under another key", async () => {
    const token = await signPublicImageToken("some-other-secret", QUIET);

    expect(await verifyPublicImageToken(encryptionKey(), token)).toBe(null);
  });
});

describe("GET /share/img/<token>", () => {
  it("serves the cover with no credentials, ignoring size", async () => {
    const response = await SELF.fetch(
      `${BASE}/share/img/${await publicImageToken(QUIET)}?size=300`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(sniffImageType(new Uint8Array(await response.arrayBuffer()))).toBe("image/png");
  });

  it("serves an artist's cover-art id as getCoverArt does", async () => {
    const response = await SELF.fetch(`${BASE}/share/img/${await publicImageToken(SILENT)}`);

    expect(response.status).toBe(200);
    await response.arrayBuffer();
  });

  it("answers a HEAD without a body", async () => {
    const token = await publicImageToken(QUIET);
    const response = await SELF.fetch(`${BASE}/share/img/${token}`, { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it.each([
    ["a tampered MAC", async () => `${(await publicImageToken(QUIET)).slice(0, -2)}AA`],
    [
      "another id under a MAC signed for this one",
      async () => `${base64Url(FALLBACK)}.${(await publicImageToken(QUIET)).split(".")[1]}`,
    ],
    ["a token of another key", () => signPublicImageToken("some-other-secret", QUIET)],
    ["no token at all", async () => "garbage"],
  ])("answers 400 for %s, without a D1 statement", async (_label, token) => {
    const { response, statements } = await counted(`/share/img/${await token()}`);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("invalid request\n");
    expect(statements).toHaveLength(0);
  });

  // Regression guards for the one unauthenticated route: malformed shapes a
  // client could send are refused before anything reaches D1, over the real
  // Worker as well as through a counting database.
  it.each([
    ["an extra dot", async () => `${await publicImageToken(QUIET)}.c`],
    ["an empty id", async () => `.${(await publicImageToken(QUIET)).split(".")[1]}`],
    ["an oversized token", async () => `${"A".repeat(10_000)}.${"A".repeat(10_000)}`],
  ])("answers 400 plain text for %s, without a D1 statement", async (_label, token) => {
    const path = `/share/img/${await token()}`;

    const response = await SELF.fetch(`${BASE}${path}`);
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("invalid request\n");

    const { response: recorded, statements } = await counted(path);
    expect(recorded.status).toBe(400);
    expect(await recorded.text()).toBe("invalid request\n");
    expect(statements).toHaveLength(0);
  });

  it("answers 404 for a valid token whose entity has no cover", async () => {
    const { response, statements } = await counted(
      `/share/img/${await publicImageToken(FALLBACK)}`,
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Artwork not found\n");
    expect(statements).toHaveLength(1);
  });

  it("serves a cover in one D1 statement and writes nothing", async () => {
    const { response, statements } = await counted(`/share/img/${await publicImageToken(QUIET)}`);

    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(statements).toHaveLength(1);
    expect(statements.reduce((total, statement) => total + statement.rowsWritten, 0)).toBe(0);
  });
});
