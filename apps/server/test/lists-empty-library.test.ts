import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browseXml } from "./browsing-support";
import { list } from "./lists-support";

/**
 * The Lists module before the first scan has indexed anything.
 *
 * This file seeds nothing, and storage is isolated per test file, so the
 * library really is empty. It is the state every client meets on its first
 * sync, and these endpoints are the ones it reads then: each has to answer
 * with a valid, empty container, because an error here can stop the sync
 * altogether (#9).
 */

beforeAll(async () => {
  await bootstrapAdmin();
});

const EMPTY = [
  ["getAlbumList2", { type: "newest" }, "albumList2"],
  ["getAlbumList2", { type: "alphabeticalByName" }, "albumList2"],
  ["getAlbumList2", { type: "alphabeticalByArtist" }, "albumList2"],
  ["getAlbumList2", { type: "byYear", fromYear: "1900", toYear: "2100" }, "albumList2"],
  ["getAlbumList2", { type: "byGenre", genre: "Ambient" }, "albumList2"],
  ["getAlbumList2", { type: "random" }, "albumList2"],
  ["getAlbumList2", { type: "starred" }, "albumList2"],
  ["getAlbumList2", { type: "recent" }, "albumList2"],
  ["getAlbumList2", { type: "frequent" }, "albumList2"],
  ["getAlbumList2", { type: "highest" }, "albumList2"],
  ["getRandomSongs", {}, "randomSongs"],
  ["getSongsByGenre", { genre: "Ambient" }, "songsByGenre"],
  ["getTopSongs", { artist: "Nobody" }, "topSongs"],
  ["getStarred2", {}, "starred2"],
] as const;

describe("the lists of an empty library", () => {
  it.each(EMPTY)("answers %s (%o) with an empty container", async (endpoint, extra) => {
    const body = await list(endpoint, { ...extra });

    expect(body.status).toBe("ok");
    expect(body.error).toBeUndefined();
  });

  it.each(EMPTY)(
    "renders %s (%o) as a well-formed childless element",
    async (endpoint, extra, element) => {
      const xml = await browseXml(`/rest/${endpoint}`, { ...extra });

      expect(xml).toContain(`<${element}/>`);
      expect(xml).not.toContain("<error");
    },
  );
});
