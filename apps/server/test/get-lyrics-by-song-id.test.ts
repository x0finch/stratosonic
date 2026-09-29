import { SELF } from "cloudflare:test";
import { albumId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_SIDECAR_BYTES } from "../src/lyrics/sidecar";
import { bootstrapAdmin, browseXml, query } from "./browsing-support";
import { fixtures, fixtureTrack } from "./fixtures/files";
import { lyrics, lyricsCounting, putSidecar } from "./lyrics-support";
import { scanUntilComplete, seedFixtureFiles, storedTracks } from "./scan-support";
import { BASE, seedTrack } from "./support";

/**
 * `getLyricsBySongId`: the lyrics in the sidecar beside a track, read from
 * the bucket when a client asks.
 *
 * The sidecars are put beside the fixture tracks before the scan runs, the
 * way rclone uploads them beside the music, so the library the endpoint
 * answers from is one a scan built with the sidecars already in the bucket.
 */

const SILENT = fixtureTrack("silent-track.mp3");
const HUSHED = fixtureTrack("hushed-interlude.flac");
const TAIL = fixtureTrack("tail-loaded.m4a");
const FRONT = fixtureTrack("front-loaded.m4a");
const UNTAGGED = fixtureTrack("untagged.mp3");

/** A track added after the scan, with a sidecar too large to read. */
const OVERSIZED = "Extra Artist/Extra Album/01 Oversized.mp3";

/** `…/04 Song.mp3` → `…/04 Song.lrc`. */
function sidecar(trackKey: string, suffix: string): string {
  return trackKey.replace(/\.[^./]+$/, suffix);
}

function songId(r2Key: string): string {
  return prefixedId("track", trackId(r2Key));
}

/**
 * Synced, behind a UTF-8 byte-order mark, with an offset, a tag it skips, a
 * line at two timestamps, Enhanced LRC word timings and background vocals.
 */
const SILENT_LRC = [
  "\uFEFF[offset:+250]",
  "[al:Quiet Album]",
  "[00:01.00]<00:01.00>First <00:01.50>line",
  "[00:20.00][00:05.00]Chorus",
  "[bg: <00:05.50>ooh]",
  "[00:10.00]Verse",
  "",
].join("\n");

/** Synced, with every ID tag the parser reads. */
const HUSHED_LRC = [
  "[ar:Echo]",
  "[ti:Interlude, Hushed]",
  "[lang:eng]",
  "[00:00.50]Softly",
  "[00:02.25]Quieter",
  "",
].join("\n");

beforeAll(async () => {
  await bootstrapAdmin();
  await seedFixtureFiles();

  await putSidecar(sidecar(SILENT.r2Key, ".lrc"), SILENT_LRC);
  await putSidecar(sidecar(HUSHED.r2Key, ".lrc"), HUSHED_LRC);
  // An `.lrc` with nothing in it, so the `.txt` beside it is the one read.
  await putSidecar(sidecar(TAIL.r2Key, ".lrc"), "\n\n");
  await putSidecar(sidecar(TAIL.r2Key, ".txt"), "Plain words\n\nMore plain words\n");
  // An `.lrc` without a single timestamp is unsynced, like a `.txt`.
  await putSidecar(sidecar(UNTAGGED.r2Key, ".lrc"), "Untimed one\nUntimed two\n");

  await scanUntilComplete();

  await seedTrack({ r2Key: OVERSIZED, title: "Oversized", artist: "Extra Artist" });
  await putSidecar(sidecar(OVERSIZED, ".lrc"), `[00:01.00]${"x".repeat(MAX_SIDECAR_BYTES)}\n`);
});

describe("the scan", () => {
  it("indexes the tracks and none of the sidecars beside them", async () => {
    const keys = (await storedTracks()).map((row) => row.r2Key);

    expect(keys).toHaveLength(fixtures.tracks.length + 1);
    expect(keys.filter((key) => /\.(lrc|txt)$/.test(key))).toEqual([]);
  });
});

describe("getLyricsBySongId", () => {
  it.each(["/rest/getLyricsBySongId", "/rest/getLyricsBySongId.view"])(
    "answers on %s",
    async (path) => {
      const xml = await browseXml(path, { id: songId(SILENT.r2Key) });

      expect(xml).toContain('status="ok"');
      expect(xml).toContain(
        '<lyricsList><structuredLyrics displayArtist="Silent Artist" displayTitle="Silent Track"' +
          ' lang="xxx" offset="250" synced="true"><line start="1000">First line</line>',
      );
    },
  );

  it("answers a form-encoded POST", async () => {
    const response = await SELF.fetch(`${BASE}/rest/getLyricsBySongId.view`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: query({ id: songId(SILENT.r2Key), f: "json" }),
    });
    const body = (await response.json()) as { "subsonic-response": { status: string } };

    expect(body["subsonic-response"].status).toBe("ok");
  });

  it("reads a synced .lrc, with the track's artist and title where it names none", async () => {
    const response = await lyrics("getLyricsBySongId", { id: songId(SILENT.r2Key) });

    expect(response.lyricsList).toEqual({
      structuredLyrics: [
        {
          displayArtist: "Silent Artist",
          displayTitle: "Silent Track",
          lang: "xxx",
          line: [
            { start: 1_000, value: "First line" },
            { start: 5_000, value: "Chorus" },
            { start: 10_000, value: "Verse" },
            { start: 20_000, value: "Chorus" },
          ],
          offset: 250,
          synced: true,
        },
      ],
    });
  });

  it("uses the file's own artist, title and language, and no offset it did not set", async () => {
    const response = await lyrics("getLyricsBySongId", { id: songId(HUSHED.r2Key) });

    expect(response.lyricsList?.structuredLyrics).toEqual([
      {
        displayArtist: "Echo",
        displayTitle: "Interlude, Hushed",
        lang: "eng",
        line: [
          { start: 500, value: "Softly" },
          { start: 2_250, value: "Quieter" },
        ],
        synced: true,
      },
    ]);
  });

  it("falls through an empty .lrc to the .txt, read unsynced", async () => {
    const response = await lyrics("getLyricsBySongId", { id: songId(TAIL.r2Key) });

    expect(response.lyricsList?.structuredLyrics).toEqual([
      {
        displayArtist: "Mute Ensemble",
        displayTitle: "Tail Loaded",
        lang: "xxx",
        line: [{ value: "Plain words" }, { value: "More plain words" }],
        synced: false,
      },
    ]);
  });

  it("reads an .lrc without timestamps unsynced", async () => {
    const response = await lyrics("getLyricsBySongId", { id: songId(UNTAGGED.r2Key) });
    const [structured] = response.lyricsList?.structuredLyrics ?? [];

    expect(structured?.synced).toBe(false);
    expect(structured?.displayTitle).toBe(UNTAGGED.pathFallback.title);
    expect(structured?.line).toEqual([{ value: "Untimed one" }, { value: "Untimed two" }]);
  });

  it("renders unsynced lines without a start in XML", async () => {
    const xml = await browseXml("/rest/getLyricsBySongId", { id: songId(TAIL.r2Key) });

    expect(xml).toContain('lang="xxx" synced="false"><line>Plain words</line>');
  });

  it("answers an empty lyricsList for a track with no sidecar", async () => {
    const response = await lyrics("getLyricsBySongId", { id: songId(FRONT.r2Key) });
    const xml = await browseXml("/rest/getLyricsBySongId", { id: songId(FRONT.r2Key) });

    expect(response.status).toBe("ok");
    expect(response.lyricsList).toEqual({});
    expect(xml).toContain("<lyricsList/>");
  });

  it("ignores a sidecar larger than a mebibyte", async () => {
    const response = await lyrics("getLyricsBySongId", { id: songId(OVERSIZED) });

    expect(response.status).toBe("ok");
    expect(response.lyricsList).toEqual({});
  });

  it("answers an empty lyricsList when R2 fails to produce the sidecar", async () => {
    const failing = new Set([sidecar(SILENT.r2Key, ".lrc"), sidecar(SILENT.r2Key, ".txt")]);
    const counted = await lyricsCounting(
      "getLyricsBySongId",
      { id: songId(SILENT.r2Key) },
      failing,
    );

    expect(counted.body.status).toBe("ok");
    expect(counted.body.lyricsList).toEqual({});
    expect(counted.r2Gets).toEqual([...failing]);
  });
});

describe("what getLyricsBySongId refuses", () => {
  it("answers error 10 without an id", async () => {
    const response = await lyrics("getLyricsBySongId");

    expect(response.status).toBe("failed");
    expect(response.error).toEqual({ code: 10, message: "missing parameter: 'id'" });
  });

  it.each([
    ["a track that does not exist", prefixedId("track", trackId("Nobody/Nothing/00 None.mp3"))],
    [
      "an album",
      prefixedId("album", albumId(SILENT.pathFallback.albumArtist, "Quiet Album", 2024)),
    ],
    ["a malformed id", "not-an-id"],
  ])("answers error 70 for %s", async (_label, id) => {
    const response = await lyrics("getLyricsBySongId", { id });

    expect(response.status).toBe("failed");
    expect(response.error?.code).toBe(70);
  });
});

describe("what getLyricsBySongId costs", () => {
  it("reads one sidecar, runs two statements and writes nothing for a hit", async () => {
    const counted = await lyricsCounting("getLyricsBySongId", { id: songId(SILENT.r2Key) });

    expect(counted.body.lyricsList?.structuredLyrics).toHaveLength(1);
    expect(counted.statements).toHaveLength(2);
    expect(counted.rowsWritten).toBe(0);
    expect(counted.r2Gets).toEqual([sidecar(SILENT.r2Key, ".lrc")]);
  });

  it("probes both suffixes, and no more, for a miss", async () => {
    const counted = await lyricsCounting("getLyricsBySongId", { id: songId(FRONT.r2Key) });

    expect(counted.body.lyricsList).toEqual({});
    expect(counted.statements).toHaveLength(2);
    expect(counted.rowsWritten).toBe(0);
    expect(counted.r2Gets).toEqual([sidecar(FRONT.r2Key, ".lrc"), sidecar(FRONT.r2Key, ".txt")]);
  });

  it("reads nothing from R2 for a track that does not exist", async () => {
    const id = prefixedId("track", trackId("Nobody/Nothing/00 None.mp3"));
    const counted = await lyricsCounting("getLyricsBySongId", { id });

    expect(counted.body.error?.code).toBe(70);
    expect(counted.rowsWritten).toBe(0);
    expect(counted.r2Gets).toEqual([]);
  });
});
