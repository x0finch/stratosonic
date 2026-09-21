import { describe, expect, it } from "vitest";
import {
  entryKeyCandidates,
  isPlaylistKey,
  parseM3u,
  playlistNameForFile,
  playlistNameFromKey,
  renderM3u,
} from "../src/playlists/m3u";
import { fixturePlaylistText, fixtures } from "./fixtures/files";

/**
 * Reading an `.m3u`, on its own: no bucket, no database, just the text and
 * the key it was stored under.
 *
 * The committed fixture is the first witness, because its manifest already
 * says line by line what each line means; the rest are the forms the fixture
 * does not carry.
 */

const PLAYLIST_KEY = fixtures.playlist.r2Key;

describe("the committed fixture", () => {
  const parsed = parseM3u(fixturePlaylistText);

  it("keeps exactly the lines the manifest calls paths", () => {
    const paths = fixtures.playlist.lines
      .filter((line) => line.resolvesTo !== null)
      .map((line) => line.text);

    expect(parsed.entries).toEqual(paths);
  });

  it("carries no name of its own, so the file name will have to do", () => {
    expect(parsed.name).toBeNull();
    expect(playlistNameFromKey(PLAYLIST_KEY)).toBe(fixtures.playlist.name);
  });

  it("resolves every path to the key the manifest says", () => {
    for (const line of fixtures.playlist.lines) {
      if (line.resolvesTo === null) {
        continue;
      }

      expect(entryKeyCandidates(PLAYLIST_KEY, line.text)).toContain(line.resolvesTo);
    }
  });

  it("strips the carriage return of the line that has one", () => {
    const withReturn = fixtures.playlist.lines.find((line) => line.carriageReturn);

    expect(withReturn?.resolvesTo).toBeTruthy();
    expect(parsed.entries.some((entry) => entry.includes("\r"))).toBe(false);
  });
});

describe("the lines a playlist can hold", () => {
  it("reads #PLAYLIST: as the playlist's name", () => {
    expect(parseM3u("#EXTM3U\n#PLAYLIST:Late Night\nA/B/c.mp3\n").name).toBe("Late Night");
  });

  it("skips every other directive, and blank lines", () => {
    const parsed = parseM3u("#EXTM3U\n#EXTINF:12,Someone - Something\n\n   \nA/B/c.mp3\n");

    expect(parsed.entries).toEqual(["A/B/c.mp3"]);
  });

  it("drops a byte-order mark rather than letting it hide the first line", () => {
    const parsed = parseM3u("﻿#EXTM3U\n#PLAYLIST:Bommed\nA/B/c.mp3\n");

    expect(parsed.name).toBe("Bommed");
    expect(parsed.entries).toEqual(["A/B/c.mp3"]);
  });

  it("reads a file written with CRLF line endings", () => {
    const parsed = parseM3u("#EXTM3U\r\n#PLAYLIST:Windows\r\nA/B/c.mp3\r\n");

    expect(parsed.name).toBe("Windows");
    expect(parsed.entries).toEqual(["A/B/c.mp3"]);
  });

  it("unescapes a file:// line, as Go's PathUnescape does", () => {
    expect(parseM3u("file:///A/B%20C/d%2Be.mp3\n").entries).toEqual(["/A/B C/d+e.mp3"]);
  });

  it("drops a file:// line that is not valid percent encoding", () => {
    expect(parseM3u("file:///A/B%ZZ/c.mp3\n").entries).toEqual([]);
  });

  it("skips a line whose suffix the scan would never have indexed", () => {
    // Navidrome's `IsAudioFile` check: a path we could not index is a path
    // that could never have matched a Track.
    expect(parseM3u("A/B/notes.txt\nA/B/c.mp3\nA/B/cover.jpg\n").entries).toEqual(["A/B/c.mp3"]);
  });

  it("keeps duplicated lines, because a playlist may play a track twice", () => {
    expect(parseM3u("A/B/c.mp3\nA/B/c.mp3\n").entries).toEqual(["A/B/c.mp3", "A/B/c.mp3"]);
  });
});

describe("where a line points", () => {
  it("reads an absolute line as a key from the root of the bucket", () => {
    expect(entryKeyCandidates("playlists/x.m3u", "/Artist/Album/01.mp3")).toEqual([
      "Artist/Album/01.mp3",
    ]);
  });

  it("resolves a relative line against the playlist's own folder first", () => {
    expect(entryKeyCandidates("playlists/x.m3u", "../Artist/Album/01.mp3")).toEqual([
      "Artist/Album/01.mp3",
    ]);
  });

  it("also offers a relative line as a key from the root", () => {
    expect(entryKeyCandidates("playlists/x.m3u", "Artist/Album/01.mp3")).toEqual([
      "playlists/Artist/Album/01.mp3",
      "Artist/Album/01.mp3",
    ]);
  });

  it("offers one candidate when the two spellings agree", () => {
    expect(entryKeyCandidates("x.m3u", "Artist/Album/01.mp3")).toEqual(["Artist/Album/01.mp3"]);
  });

  it("resolves . and doubled separators away", () => {
    expect(entryKeyCandidates("a/b/x.m3u", "./c//01.mp3")).toEqual(["a/b/c/01.mp3", "c/01.mp3"]);
  });

  it("offers nothing for a path that climbs above the bucket", () => {
    expect(entryKeyCandidates("playlists/x.m3u", "../../../elsewhere/01.mp3")).toEqual([]);
  });
});

describe("which objects are playlists", () => {
  it("accepts the two playlist suffixes, whatever their case", () => {
    expect(isPlaylistKey("playlists/a.m3u")).toBe(true);
    expect(isPlaylistKey("playlists/a.M3U8")).toBe(true);
  });

  it("rejects everything else in the bucket", () => {
    expect(isPlaylistKey("Artist/Album/01.mp3")).toBe(false);
    expect(isPlaylistKey("_covers/abc.png")).toBe(false);
    expect(isPlaylistKey("playlists/README")).toBe(false);
  });

  it("rejects a hidden file, as Navidrome's playlist phase does", () => {
    expect(isPlaylistKey("playlists/.hidden.m3u")).toBe(false);
  });

  it("names a playlist after its file, without the extension", () => {
    expect(playlistNameFromKey("playlists/Late Night.m3u8")).toBe("Late Night");
    expect(playlistNameFromKey("favourites.m3u")).toBe("favourites");
  });
});

describe("writing a playlist back", () => {
  const NAME = "Late Night";
  const KEYS = ["Artist/Album/01 One.mp3", "Other/Album/02 Two.flac", "Artist/Album/01 One.mp3"];

  it("renders the header, the name and one key per line", () => {
    expect(renderM3u(NAME, KEYS)).toBe(`#EXTM3U\n#PLAYLIST:Late Night\n${KEYS.join("\n")}\n`);
  });

  it("round-trips: what it writes, the parser reads back unchanged", () => {
    const parsed = parseM3u(renderM3u(NAME, KEYS));

    expect(parsed.name).toBe(NAME);
    expect(parsed.entries).toEqual(KEYS);
  });

  it("writes keys the import resolves from the root, wherever the file sits", () => {
    const parsed = parseM3u(renderM3u(NAME, KEYS));

    for (const entry of parsed.entries) {
      expect(entryKeyCandidates("playlists/anything.m3u", entry)).toContain(entry);
    }
  });

  it("writes a key that begins with a # in the absolute spelling", () => {
    const hashed = "#1 Artist/Album/01 One.mp3";

    expect(parseM3u(renderM3u(NAME, [hashed])).entries).toEqual([`/${hashed}`]);
    expect(entryKeyCandidates("playlists/x.m3u", `/${hashed}`)).toEqual([hashed]);
  });

  it("keeps a name to one line, so the file cannot say something else", () => {
    expect(playlistNameForFile("  Two\nLines  ")).toBe("Two Lines");
    expect(parseM3u(renderM3u("  Two\nLines  ", [])).name).toBe("Two Lines");
  });
});
