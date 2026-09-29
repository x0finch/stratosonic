import { prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin, browseXml } from "./browsing-support";
import {
  type FixtureLyricsTrack,
  fixtureBytes,
  fixtureLyricsTrack,
  fixtures,
} from "./fixtures/files";
import { lyrics, lyricsCounting, putSidecar } from "./lyrics-support";
import { scanUntilComplete } from "./scan-support";
import { testEnv } from "./support";

/**
 * The lyrics endpoints answering from a track's own tags: the lyric the scan
 * stored, read when no sidecar beside the track has one.
 *
 * The library is the lyrics fixtures, put in the bucket and scanned, so what
 * is served is what a scan made of real tags - an ID3v2.3 `USLT`, an ID3v2.4
 * `SYLT`, a Vorbis `LYRICS` and an MP4 `©lyr`.
 */

const USLT = fixtureLyricsTrack("lyrics-uslt.mp3");
const SYLT = fixtureLyricsTrack("lyrics-sylt.mp3");

function songId(r2Key: string): string {
  return prefixedId("track", trackId(r2Key));
}

function sidecar(trackKey: string, suffix: string): string {
  return trackKey.replace(/\.[^./]+$/, suffix);
}

/** The `structuredLyrics` a fixture's tags should come back as. */
function expectedStructured(fixture: FixtureLyricsTrack) {
  return {
    displayArtist: fixture.lyrics.displayArtist ?? fixture.tags?.artist,
    displayTitle: fixture.tags?.title,
    lang: fixture.lyrics.lang,
    line: fixture.lyrics.lines,
    synced: fixture.lyrics.synced,
  };
}

beforeAll(async () => {
  await bootstrapAdmin();

  for (const fixture of fixtures.lyricsTracks) {
    await testEnv.MUSIC.put(fixture.r2Key, fixtureBytes(fixture.file));
  }

  await scanUntilComplete();
});

describe("getLyricsBySongId, for a track with no sidecar", () => {
  it.each(fixtures.lyricsTracks.map((fixture) => [fixture.lyrics.tag, fixture] as const))(
    "answers with the lyric in its %s tag",
    async (_tag, fixture) => {
      const response = await lyrics("getLyricsBySongId", { id: songId(fixture.r2Key) });

      expect(response.status).toBe("ok");
      expect(response.lyricsList).toEqual({ structuredLyrics: [expectedStructured(fixture)] });
    },
  );

  it("answers a SYLT synced, with each line's start and the frame's language", async () => {
    const xml = await browseXml("/rest/getLyricsBySongId", { id: songId(SYLT.r2Key) });

    expect(xml).toContain(
      '<lyricsList><structuredLyrics displayArtist="Lyric Singer" displayTitle="Timed Words"' +
        ' lang="deu" synced="true"><line start="1000">Eins</line><line start="2500">Zwei</line>' +
        '<line start="65430">Drei</line></structuredLyrics></lyricsList>',
    );
  });

  it("answers a USLT unsynced, in the frame's language, in XML", async () => {
    const xml = await browseXml("/rest/getLyricsBySongId", { id: songId(USLT.r2Key) });

    expect(xml).toContain(
      'displayTitle="Unsynced Words" lang="eng" synced="false">' +
        "<line>Première ligne</line><line>Zweite Zeile</line>",
    );
  });

  it("probes both sidecars first, runs two statements and writes nothing", async () => {
    const counted = await lyricsCounting("getLyricsBySongId", { id: songId(SYLT.r2Key) });

    expect(counted.body.lyricsList?.structuredLyrics).toEqual([expectedStructured(SYLT)]);
    expect(counted.statements).toHaveLength(2);
    expect(counted.rowsWritten).toBe(0);
    expect(counted.r2Gets).toEqual([sidecar(SYLT.r2Key, ".lrc"), sidecar(SYLT.r2Key, ".txt")]);
  });
});

describe("getLyricsBySongId, for a track with a sidecar as well", () => {
  it("answers with the sidecar, even a .txt, and not the tags", async () => {
    const key = sidecar(USLT.r2Key, ".txt");
    await putSidecar(key, "From the sidecar\n");

    try {
      const response = await lyrics("getLyricsBySongId", { id: songId(USLT.r2Key) });

      expect(response.lyricsList?.structuredLyrics).toEqual([
        {
          displayArtist: "Lyric Singer",
          displayTitle: "Unsynced Words",
          lang: "xxx",
          line: [{ value: "From the sidecar" }],
          synced: false,
        },
      ]);
    } finally {
      await testEnv.MUSIC.delete(key);
    }
  });
});

describe("getLyrics, for a song whose only lyrics are in its tags", () => {
  it("answers with their lines, without timestamps, in JSON and XML", async () => {
    const response = await lyrics("getLyrics", { artist: "Lyric Singer", title: "Timed Words" });
    const xml = await browseXml("/rest/getLyrics", {
      artist: "Lyric Singer",
      title: "Timed Words",
    });

    expect(response.lyrics).toEqual({
      artist: "Lyric Singer",
      title: "Timed Words",
      value: "Eins\nZwei\nDrei\n",
    });
    expect(xml).toContain('<lyrics artist="Lyric Singer" title="Timed Words">Eins\nZwei\nDrei\n');
  });

  it("probes the sidecars first, runs two statements and writes nothing", async () => {
    const counted = await lyricsCounting("getLyrics", {
      artist: "Lyric Singer",
      title: "Commented Words",
    });

    expect(counted.body.lyrics?.value).toBe("Sung in a comment\nStill in time\n");
    expect(counted.statements).toHaveLength(2);
    expect(counted.rowsWritten).toBe(0);
    expect(counted.r2Gets).toHaveLength(2);
  });
});
