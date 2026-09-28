import { SELF } from "cloudflare:test";
import { albumId, artistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { subsonicToken } from "../src/auth/crypto";
import { sniffImageType } from "../src/media/images";
import { bootstrapAdmin, browseXml } from "./browsing-support";
import {
  type InfoResponse,
  imagesOf,
  info,
  infoCounting,
  infoPost,
  publicImageToken,
} from "./info-support";
import { BASE, seedFixtureLibrary, seedFixtureObjects, seedPlaylist } from "./support";

/**
 * `getArtistInfo` and `getArtistInfo2` against the seeded fixture library.
 *
 * With no external agent, Navidrome's answer is the three image URLs of the
 * artist's own artwork and nothing else (server/subsonic/browsing.go
 * `getArtistInfo`): no biography, no Last.fm link, no similar artists. The
 * fixtures give an artist with one album with a cover (Silent Artist), one
 * with two (Mute Ensemble, whose cover is the earlier-named album's), and one
 * with no cover at all (Fallback Artist).
 */

const SILENT = prefixedId("artist", artistId("Silent Artist"));
const MUTE = prefixedId("artist", artistId("Mute Ensemble"));
const FALLBACK = prefixedId("artist", artistId("Fallback Artist"));
const QUIET = prefixedId("album", albumId("Silent Artist", "Quiet Album", 2001));
const FASTSTART = prefixedId("album", albumId("Mute Ensemble", "Faststart Sessions", 2019));
const TRAILING = prefixedId("album", albumId("Mute Ensemble", "Trailing Sessions", 2019));
const TAIL_LOADED = prefixedId(
  "track",
  trackId("Mute Ensemble/Trailing Sessions/01 Tail Loaded.m4a"),
);

let playlistId = "";

beforeAll(async () => {
  await bootstrapAdmin();
  const library = await seedFixtureLibrary();
  await seedFixtureObjects();
  const playlist = await seedPlaylist({ r2Key: "playlists/mix.m3u", tracks: library.tracks });
  playlistId = prefixedId("playlist", playlist.id);
});

describe.each([
  ["getArtistInfo", "artistInfo"],
  ["getArtistInfo2", "artistInfo2"],
] as const)("%s", (endpoint, element) => {
  it.each([`/rest/${endpoint}`, `/rest/${endpoint}.view`])("answers XML on %s", async (path) => {
    const xml = await browseXml(path, { id: SILENT });

    expect(xml).toContain('status="ok"');
    const token = await publicImageToken(QUIET);
    expect(xml).toContain(
      `<${element}><smallImageUrl>${BASE}/share/img/${token}?size=300</smallImageUrl>` +
        `<mediumImageUrl>${BASE}/share/img/${token}?size=600</mediumImageUrl>`,
    );
    expect(xml).toContain(`</largeImageUrl></${element}>`);
  });

  it("answers the artist's own artwork and nothing an agent would fill", async () => {
    const body = await info(endpoint, { id: SILENT });

    expect(body.status).toBe("ok");
    expect(body[element]).toEqual(await imagesOf(QUIET));
  });

  it("uses the cover the artist element carries, the first album's", async () => {
    const body = await info(endpoint, { id: MUTE });

    expect(body[element]).toEqual(await imagesOf(FASTSTART));
  });

  it("answers an empty element for an artist with no artwork", async () => {
    const body = await info(endpoint, { id: FALLBACK });

    expect(body[element]).toEqual({});
    expect(await browseXml(`/rest/${endpoint}`, { id: FALLBACK })).toContain(`<${element}/>`);
  });

  it("names no similar artist, whatever count and includeNotPresent ask for", async () => {
    const body = await info(endpoint, { id: SILENT, count: "5", includeNotPresent: "true" });

    expect(body[element]).toEqual(await imagesOf(QUIET));
  });

  it("follows an album to its artist, as Navidrome's getArtist does", async () => {
    const body = await info(endpoint, { id: TRAILING });

    expect(body[element]).toEqual(await imagesOf(FASTSTART));
  });

  it("follows a song to its artist", async () => {
    const body = await info(endpoint, { id: TAIL_LOADED });

    expect(body[element]).toEqual(await imagesOf(FASTSTART));
  });

  it("answers a form POST", async () => {
    const xml = await infoPost(`/rest/${endpoint}.view`, { id: SILENT });

    expect(xml).toContain('status="ok"');
    expect(xml).toContain(`/share/img/${await publicImageToken(QUIET)}?size=600<`);
  });

  it("builds the address from X-Forwarded-Host and X-Forwarded-Proto", async () => {
    const json = await infoPost(
      `/rest/${endpoint}`,
      { id: SILENT, f: "json" },
      { "X-Forwarded-Host": "music.example.org, proxy.internal", "X-Forwarded-Proto": "http" },
    );
    const body = JSON.parse(json)["subsonic-response"];

    expect(body[element]).toEqual(await imagesOf(QUIET, "http://music.example.org"));
  });

  it.each([
    ["a password", async () => ({ p: "sesame" })],
    ["a token and salt", async () => ({ t: await subsonicToken("sesame", "c19b2d"), s: "c19b2d" })],
  ])("carries no credential of the caller's when it sent %s", async (_label, credentials) => {
    const params = new URLSearchParams({
      u: "admin",
      ...(await credentials()),
      v: "1.16.1",
      c: "Amperfy",
      f: "json",
      id: SILENT,
    });
    const response = await SELF.fetch(`${BASE}/rest/${endpoint}?${params}`);
    const body = (await response.json()) as { "subsonic-response": InfoResponse };
    const urls = Object.values(body["subsonic-response"][element] ?? {}) as string[];

    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect([...new URL(url).searchParams.keys()]).toEqual(["size"]);
      expect(url).not.toMatch(/sesame|c19b2d|admin/);
    }
  });

  it("points at a public URL that serves the cover with no credentials at all", async () => {
    const body = await info(endpoint, { id: SILENT });
    const response = await SELF.fetch(body[element]?.largeImageUrl ?? "");

    expect(response.status).toBe(200);
    expect(sniffImageType(new Uint8Array(await response.arrayBuffer()))).toBe("image/png");
  });

  it("answers error 10 without an id", async () => {
    const body = await info(endpoint);

    expect(body.status).toBe("failed");
    expect(body.error).toEqual({ code: 10, message: "missing parameter: 'id'" });
  });

  it.each([
    ["an artist that does not exist", () => prefixedId("artist", artistId("Nobody"))],
    ["an album that does not exist", () => prefixedId("album", albumId("Nobody", "None", null))],
    ["a playlist", () => playlistId],
    ["a malformed id", () => "not-an-id"],
  ])("answers error 70 for %s", async (_label, id) => {
    const body = await info(endpoint, { id: id() });

    expect(body.status).toBe("failed");
    expect(body.error).toEqual({ code: 70, message: "data not found" });
  });

  it("runs one statement beyond authentication and writes nothing", async () => {
    const counted = await infoCounting(endpoint, { id: TAIL_LOADED });

    expect(counted.body[element]).toEqual(await imagesOf(FASTSTART));
    expect(counted.statements).toHaveLength(2);
    expect(counted.rowsWritten).toBe(0);
  });
});
