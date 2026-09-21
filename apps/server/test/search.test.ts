import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin } from "./browsing-support";
import {
  albumNames,
  artistNames,
  search,
  searchByPost,
  searchXml,
  songTitles,
} from "./search-support";
import { seedAlbum, seedArtist, seedTrack } from "./support";

/**
 * `search2` and `search3`: matching the library by name.
 *
 * The two share one matcher and differ only in how they render a hit, so most
 * assertions run against `search3` (the ID3 shape) and a smaller set proves
 * `search2` returns the same items under the folder view's elements.
 *
 * The seeded library is chosen so a single query reaches every kind: "beat" is
 * a substring of three artists, three albums — two by name and Help! through
 * its album artist — and, through the album name and the track's artist, three
 * songs, with one artist, album and song that contains it nowhere as a
 * control.
 */

const ARTISTS = ["The Beatles", "Beatnik", "Heartbeat Trio", "Quietus"];

interface AlbumSpec {
  readonly artist: string;
  readonly name: string;
  readonly year: number;
}

const HELP: AlbumSpec = { artist: "The Beatles", name: "Help!", year: 1965 };
const BEAT_PARADE: AlbumSpec = { artist: "The Beatles", name: "Beat Parade", year: 1963 };
const OFFBEAT: AlbumSpec = { artist: "Beatnik", name: "Offbeat", year: 2001 };
const SILENCE: AlbumSpec = { artist: "Quietus", name: "Silence", year: 2010 };

const ALBUMS: readonly AlbumSpec[] = [HELP, BEAT_PARADE, OFFBEAT, SILENCE];

interface TrackSpec {
  readonly album: AlbumSpec;
  readonly title: string;
}

const TRACKS: readonly TrackSpec[] = [
  { album: HELP, title: "Help" },
  { album: BEAT_PARADE, title: "Ticket to Ride" },
  { album: OFFBEAT, title: "Groove" },
  { album: SILENCE, title: "Hush" },
];

beforeAll(async () => {
  await bootstrapAdmin();

  for (const name of ARTISTS) {
    await seedArtist({ name });
  }
  for (const album of ALBUMS) {
    await seedAlbum({
      name: album.name,
      albumArtist: album.artist,
      year: album.year,
      songCount: 1,
    });
  }
  for (const [index, spec] of TRACKS.entries()) {
    await seedTrack({
      r2Key: `${spec.album.artist}/${spec.album.name}/${index} ${spec.title}.mp3`,
      title: spec.title,
      album: spec.album.name,
      albumArtist: spec.album.artist,
      year: spec.album.year,
    });
  }
});

describe("search3 matching", () => {
  it("finds artists, albums and songs by a case-insensitive substring", async () => {
    const result = (await search("search3", { query: "BEAT" })).searchResult3;

    expect(artistNames(result).sort()).toEqual(["Beatnik", "Heartbeat Trio", "The Beatles"]);
    // "Help!" comes back through its album artist, The Beatles.
    expect(albumNames(result).sort()).toEqual(["Beat Parade", "Help!", "Offbeat"]);
    // "Help" through its artist, "Ticket to Ride" through its album, "Groove"
    // through both — "Hush" through nothing.
    expect(songTitles(result).sort()).toEqual(["Groove", "Help", "Ticket to Ride"]);
  });

  it("matches a song by the album name it carries", async () => {
    const result = (await search("search3", { query: "parade" })).searchResult3;

    expect(songTitles(result)).toEqual(["Ticket to Ride"]);
    expect(albumNames(result)).toEqual(["Beat Parade"]);
  });

  it("requires every word of a multi-word query", async () => {
    const result = (await search("search3", { query: "beatles help" })).searchResult3;

    // The one track that is both a Beatles track and titled Help, and the
    // album Help! — "beatles" matches its album artist and "help" its name,
    // the way Navidrome's full_text carries both. The artist "The Beatles"
    // matches "beatles" but not "help", so no artist comes back.
    expect(songTitles(result)).toEqual(["Help"]);
    expect(albumNames(result)).toEqual(["Help!"]);
    expect(artistNames(result)).toEqual([]);
  });

  it("drops a trailing * a client appends to the query", async () => {
    // Substreamer and others send "beat*" for a prefix search; the star is not
    // a wildcard here, and matched literally it would find nothing.
    const result = (await search("search3", { query: "beat*" })).searchResult3;

    expect(artistNames(result).sort()).toEqual(["Beatnik", "Heartbeat Trio", "The Beatles"]);
    expect(songTitles(result).sort()).toEqual(["Groove", "Help", "Ticket to Ride"]);
  });

  it("matches nothing a word is absent from", async () => {
    const result = (await search("search3", { query: "nowherefound" })).searchResult3;

    expect(result).toEqual({});
  });

  it("serves a query with more words than one statement may bind", async () => {
    // D1 allows a hundred bound parameters per query and every word binds one
    // per column, so a long query drops its surplus words instead of failing
    // the read. None of these words is in the library, so nothing comes back.
    const query = Array.from({ length: 40 }, (_, at) => `nowhere${at}`).join(" ");
    const body = await search("search3", { query });

    expect(body.error).toBeUndefined();
    expect(body.searchResult3).toEqual({});
  });

  it("treats a wildcard character as a literal, not a pattern", async () => {
    // "%" would match every row if it leaked into LIKE unescaped.
    const result = (await search("search3", { query: "%" })).searchResult3;

    expect(result).toEqual({});
  });
});

describe("search3 enumeration and paging", () => {
  it("returns the whole library for an empty query", async () => {
    const result = (await search("search3", { query: "" })).searchResult3;

    expect(artistNames(result)).toHaveLength(ARTISTS.length);
    expect(albumNames(result)).toHaveLength(ALBUMS.length);
    expect(songTitles(result)).toHaveLength(TRACKS.length);
  });

  it("pages each kind independently and stably", async () => {
    // Songs order by title: Groove, Help, Hush, Ticket to Ride.
    const first = (await search("search3", { query: "", songCount: "2", songOffset: "0" }))
      .searchResult3;
    const second = (await search("search3", { query: "", songCount: "2", songOffset: "2" }))
      .searchResult3;

    expect(songTitles(first)).toEqual(["Groove", "Help"]);
    expect(songTitles(second)).toEqual(["Hush", "Ticket to Ride"]);
  });

  it("honours a per-kind count and returns none of a kind asked for zero", async () => {
    const result = (
      await search("search3", { query: "", artistCount: "1", albumCount: "0", songCount: "2" })
    ).searchResult3;

    expect(artistNames(result)).toHaveLength(1);
    expect(result?.album).toBeUndefined();
    expect(songTitles(result)).toHaveLength(2);
  });

  it("caps a count at 500 however large a one the client sends", async () => {
    // The library is far smaller than the cap, so what this pins is that a
    // count no server should honour is served, bounded, rather than passed
    // through to D1 as a limit of a hundred thousand rows.
    const result = (await search("search3", { query: "", songCount: "100000" })).searchResult3;

    expect(songTitles(result).length).toBeLessThanOrEqual(500);
    expect(songTitles(result)).toHaveLength(TRACKS.length);
  });

  it("defaults each kind's count to 20", async () => {
    const result = (await search("search3", { query: "" })).searchResult3;

    // Fewer than 20 of each exist, so the default returns them all rather than
    // capping — the assertion is that nothing is dropped by an absent count.
    expect(songTitles(result)).toHaveLength(TRACKS.length);
  });
});

describe("search2 rendering", () => {
  it("returns the same items as search3", async () => {
    const result = (await search("search2", { query: "beat" })).searchResult2;

    expect((result?.artist ?? []).map((artist) => artist.name).sort()).toEqual([
      "Beatnik",
      "Heartbeat Trio",
      "The Beatles",
    ]);
    expect((result?.album ?? []).map((album) => album.name).sort()).toEqual([
      "Beat Parade",
      "Help!",
      "Offbeat",
    ]);
    expect(songTitles(result).sort()).toEqual(["Groove", "Help", "Ticket to Ride"]);
  });

  it("renders each album as a directory child, unlike search3's AlbumID3", async () => {
    const two = (await search("search2", { query: "parade" })).searchResult2;
    const three = (await search("search3", { query: "parade" })).searchResult3;

    expect(two?.album?.[0]?.isDir).toBe(true);
    // AlbumID3 has no isDir; the folder child does.
    expect(three?.album?.[0]).not.toHaveProperty("isDir");
  });

  it("renders each artist without the ID3 album count", async () => {
    const two = (await search("search2", { query: "beatnik" })).searchResult2;
    const three = (await search("search3", { query: "beatnik" })).searchResult3;

    expect(two?.artist?.[0]).not.toHaveProperty("albumCount");
    expect(typeof three?.artist?.[0]?.albumCount).toBe("number");
  });
});

describe("search request handling", () => {
  it("is error 10 when query is missing entirely", async () => {
    // The support helper sends credentials but no `query` unless asked to.
    const body = await search("search3", {});

    expect(body.error).toEqual({ code: 10, message: "missing parameter: 'query'" });
  });

  it("is error 70 for a music folder this server does not have", async () => {
    const body = await search("search3", { query: "beat", musicFolderId: "2" });

    expect(body.error).toEqual({ code: 70, message: "Library 2 not found or not accessible" });
  });

  it.each(["/rest/search3", "/rest/search3.view"])(
    "answers on %s with the XML container",
    async (path) => {
      const xml = await searchXml(path, { query: "beat" });

      expect(xml).toContain("<searchResult3");
      expect(xml).toContain("<song ");
      expect(xml).not.toContain("<error");
    },
  );

  it("accepts the query in a POST body", async () => {
    const result = (await searchByPost("search3", { query: "parade" })).searchResult3;

    expect(songTitles(result)).toEqual(["Ticket to Ride"]);
  });

  it("writes the children in Navidrome's order: artist, album, song", async () => {
    const xml = await searchXml("/rest/search3", { query: "beat" });
    const order = ["<artist ", "<album ", "<song "].map((tag) => xml.indexOf(tag));

    expect(order.every((at) => at > 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });
});
