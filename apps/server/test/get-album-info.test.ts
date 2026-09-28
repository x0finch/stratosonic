import { SELF } from "cloudflare:test";
import { albumId, artistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { sniffImageType } from "../src/media/images";
import { bootstrapAdmin, browseXml } from "./browsing-support";
import { info, infoCounting, infoPost } from "./info-support";
import { BASE, seedFixtureLibrary, seedFixtureObjects, seedPlaylist } from "./support";

/**
 * `getAlbumInfo` and `getAlbumInfo2` against the seeded fixture library.
 *
 * Navidrome mounts one handler under both names, and it answers `<albumInfo>`
 * for both (server/subsonic/api.go, browsing.go `GetAlbumInfo`). With no
 * external agent there are no notes and no Last.fm link, so what is left is
 * the three image URLs of the album's own cover, or nothing for an album
 * without one.
 */

const QUIET = prefixedId("album", albumId("Silent Artist", "Quiet Album", 2001));
const FALLBACK = prefixedId("album", albumId("Fallback Artist", "Fallback Album", null));
const HUSHED = prefixedId("track", trackId("Silent Artist/Quiet Album/02 Hushed Interlude.flac"));
const CREDENTIALS = "u=admin&p=sesame&v=1.16.1&c=Substreamer";

function imagesOf(coverArtId: string): Record<string, string> {
  const url = (size: number) =>
    `${BASE}/rest/getCoverArt?id=${coverArtId}&size=${size}&${CREDENTIALS}`;

  return { smallImageUrl: url(300), mediumImageUrl: url(600), largeImageUrl: url(1200) };
}

let playlistId = "";

beforeAll(async () => {
  await bootstrapAdmin();
  const library = await seedFixtureLibrary();
  await seedFixtureObjects();
  const playlist = await seedPlaylist({ r2Key: "playlists/mix.m3u", tracks: library.tracks });
  playlistId = prefixedId("playlist", playlist.id);
});

describe.each(["getAlbumInfo", "getAlbumInfo2"])("%s", (endpoint) => {
  it.each([`/rest/${endpoint}`, `/rest/${endpoint}.view`])("answers XML on %s", async (path) => {
    const xml = await browseXml(path, { id: QUIET });

    expect(xml).toContain('status="ok"');
    expect(xml).toContain(
      `<albumInfo><smallImageUrl>${BASE}/rest/getCoverArt?id=${QUIET}&amp;size=300&amp;`,
    );
    expect(xml).toContain("</largeImageUrl></albumInfo>");
  });

  it("answers the album's own cover and nothing an agent would fill", async () => {
    const body = await info(endpoint, { id: QUIET });

    expect(body.status).toBe("ok");
    expect(body.albumInfo).toEqual(imagesOf(QUIET));
  });

  it("answers an empty element for an album with no cover", async () => {
    const body = await info(endpoint, { id: FALLBACK });

    expect(body.albumInfo).toEqual({});
    expect(await browseXml(`/rest/${endpoint}`, { id: FALLBACK })).toContain("<albumInfo/>");
  });

  it("follows a song to its album, as Navidrome's getAlbum does", async () => {
    const body = await info(endpoint, { id: HUSHED });

    expect(body.albumInfo).toEqual(imagesOf(QUIET));
  });

  it("answers a form POST", async () => {
    const xml = await infoPost(`/rest/${endpoint}`, { id: QUIET });

    expect(xml).toContain('status="ok"');
    expect(xml).toContain(`?id=${QUIET}&amp;size=1200&amp;u=admin&amp;p=sesame&amp;`);
  });

  it("points at a getCoverArt URL that serves the cover", async () => {
    const body = await info(endpoint, { id: QUIET });
    const response = await SELF.fetch(body.albumInfo?.smallImageUrl ?? "");

    expect(response.status).toBe(200);
    expect(sniffImageType(new Uint8Array(await response.arrayBuffer()))).toBe("image/png");
  });

  it("answers error 10 without an id", async () => {
    const body = await info(endpoint);

    expect(body.error).toEqual({ code: 10, message: "missing parameter: 'id'" });
  });

  it.each([
    ["an album that does not exist", () => prefixedId("album", albumId("Nobody", "None", null))],
    ["a song that does not exist", () => prefixedId("track", trackId("Nobody/None/01.mp3"))],
    [
      "an artist, which Navidrome's getAlbum does not follow",
      () => prefixedId("artist", artistId("Silent Artist")),
    ],
    ["a playlist", () => playlistId],
    ["a malformed id", () => "al-short"],
  ])("answers error 70 for %s", async (_label, id) => {
    const body = await info(endpoint, { id: id() });

    expect(body.status).toBe("failed");
    expect(body.error).toEqual({ code: 70, message: "data not found" });
  });

  it("runs one statement beyond authentication and writes nothing", async () => {
    const counted = await infoCounting(endpoint, { id: HUSHED });

    expect(counted.body.albumInfo).toEqual(imagesOf(QUIET));
    expect(counted.statements).toHaveLength(2);
    expect(counted.rowsWritten).toBe(0);
  });
});
