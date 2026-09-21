import { albumId, artistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browse, browseXml } from "./browsing-support";

/**
 * Browsing before the first scan has indexed anything.
 *
 * This file seeds nothing, and storage is isolated per test file, so the
 * library really is empty here. A client meets exactly this state on its
 * first sync: the list endpoints have to answer with empty containers rather
 * than errors — Navidrome answers `getArtists` with error 70 in this state,
 * and a client that treats that as fatal never finishes syncing (#9).
 */

beforeAll(async () => {
  await bootstrapAdmin();
});

describe("browsing an empty library", () => {
  it("answers getArtists with an empty artists element", async () => {
    const body = await browse("getArtists");

    expect(body.status).toBe("ok");
    expect(body.artists?.ignoredArticles).toBe("The El La Los Las Le Les Os As O A");
    expect(body.artists).not.toHaveProperty("index");
  });

  it("answers getArtists in XML with a well-formed, childless element", async () => {
    const xml = await browseXml("/rest/getArtists");

    expect(xml).toContain('<artists ignoredArticles="The El La Los Las Le Les Os As O A"/>');
    expect(xml).not.toContain("<error");
  });

  it("answers getGenres with an empty genres element", async () => {
    const body = await browse("getGenres");

    expect(body.status).toBe("ok");
    expect(body.genres).toEqual({});
    expect(await browseXml("/rest/getGenres")).toContain("<genres/>");
  });

  it("answers getIndexes with a dated but childless indexes element", async () => {
    const body = await browse("getIndexes");

    expect(body.status).toBe("ok");
    expect(body.indexes?.ignoredArticles).toBe("The El La Los Las Le Les Os As O A");
    expect(body.indexes?.lastModified).toBeGreaterThan(0);
    expect(body.indexes).not.toHaveProperty("index");
    expect(await browseXml("/rest/getIndexes")).toMatch(/<indexes lastModified="\d+"[^>]*\/>/);
  });

  it("still offers the music folder there is nothing in yet", async () => {
    const body = await browse("getMusicFolders");

    expect(body.status).toBe("ok");
    expect(body.musicFolders?.musicFolder).toEqual([{ id: 1, name: "Music Library" }]);
  });

  it("says an artist, an album and a song are not found rather than failing oddly", async () => {
    const asked = [
      ["getArtist", prefixedId("artist", artistId("Nobody"))],
      ["getAlbum", prefixedId("album", albumId("Nobody", "Nothing", 2000))],
      ["getSong", prefixedId("track", trackId("Nobody/Nothing/1.mp3"))],
      ["getMusicDirectory", prefixedId("artist", artistId("Nobody"))],
    ] as const;

    for (const [endpoint, id] of asked) {
      const body = await browse(endpoint, { id });

      expect(body.status).toBe("failed");
      expect(body.error?.code).toBe(70);
    }
  });
});
