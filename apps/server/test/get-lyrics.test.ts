import { beforeAll, describe, expect, it } from "vitest";
import { D1_MAX_BOUND_PARAMETERS } from "../src/d1-limits";
import { MAX_LYRICS_CANDIDATES } from "../src/lyrics/repository";
import { bootstrapAdmin, browseXml } from "./browsing-support";
import { lyrics, lyricsCounting, putSidecar } from "./lyrics-support";
import { seedTrack } from "./support";

/**
 * `getLyrics`: the plain text of a song's lyrics, found by artist and title.
 *
 * The library is seeded row by row rather than scanned, because what is under
 * test is which track the lookup picks - by title, by the track's artist or
 * its album artist, newest first - and every row says exactly what it is. The
 * sidecars are put beside those tracks' keys in the bucket.
 */

const SONG = "Artist A/Album A/01 Song.mp3";
const DUET = "Host/Duets/01 Duet.mp3";

/** Three takes of one song, newest first; the newest has no sidecar. */
const TWINS = ["Twins/Newest/01 Twin.mp3", "Twins/Middle/01 Twin.mp3", "Twins/Oldest/01 Twin.mp3"];

/** More takes than the lookup looks at; only the oldest has a sidecar. */
const CROWD = Array.from(
  { length: MAX_LYRICS_CANDIDATES + 2 },
  (_, index) => `Crowd/Take ${String(index).padStart(2, "0")}/01 Crowded.mp3`,
);

function sidecar(trackKey: string, suffix = ".lrc"): string {
  return trackKey.replace(/\.[^./]+$/, suffix);
}

/** An instant this many minutes after a fixed one, for ordering the takes. */
function minutes(count: number): Date {
  return new Date(1_700_000_000_000 + count * 60_000);
}

beforeAll(async () => {
  await bootstrapAdmin();

  await seedTrack({ r2Key: SONG, title: "Song", artist: "Artist A" });
  await putSidecar(sidecar(SONG), "[ar:Tagged]\n[00:01.00]First line\n[00:02.50]Second line\n");

  await seedTrack({ r2Key: DUET, title: "Duet", artist: "Guest feat. Host", albumArtist: "Host" });
  await putSidecar(sidecar(DUET, ".txt"), "Together\n\nApart\n");

  for (const [index, key] of TWINS.entries()) {
    await seedTrack({ r2Key: key, title: "Twin", artist: "Twins", updatedAt: minutes(-index) });
  }
  await putSidecar(sidecar(TWINS[1] ?? ""), "[00:01.00]from the middle take\n");
  await putSidecar(sidecar(TWINS[2] ?? ""), "[00:01.00]from the oldest take\n");

  for (const [index, key] of CROWD.entries()) {
    await seedTrack({ r2Key: key, title: "Crowded", artist: "Crowd", updatedAt: minutes(-index) });
  }
  await putSidecar(sidecar(CROWD.at(-1) ?? ""), "[00:01.00]too far back\n");
});

describe("getLyrics", () => {
  it.each(["/rest/getLyrics", "/rest/getLyrics.view"])("answers on %s", async (path) => {
    const xml = await browseXml(path, { artist: "Artist A", title: "Song" });

    expect(xml).toContain('status="ok"');
    expect(xml).toContain(
      '<lyrics artist="Artist A" title="Song">First line\nSecond line\n</lyrics>',
    );
  });

  it("sends each line's text with a newline, and no timestamps", async () => {
    const response = await lyrics("getLyrics", { artist: "Artist A", title: "Song" });

    expect(response.status).toBe("ok");
    expect(response.lyrics).toEqual({
      artist: "Artist A",
      title: "Song",
      value: "First line\nSecond line\n",
    });
  });

  it("matches the album artist as well as the track's own", async () => {
    const byAlbumArtist = await lyrics("getLyrics", { artist: "Host", title: "Duet" });
    const byTrackArtist = await lyrics("getLyrics", { artist: "Guest feat. Host", title: "Duet" });

    expect(byAlbumArtist.lyrics).toEqual({
      artist: "Host",
      title: "Duet",
      value: "Together\nApart\n",
    });
    expect(byTrackArtist.lyrics?.value).toBe("Together\nApart\n");
  });

  it("answers with the newest take that has lyrics", async () => {
    const response = await lyrics("getLyrics", { artist: "Twins", title: "Twin" });

    expect(response.lyrics?.value).toBe("from the middle take\n");
  });

  it.each([
    ["a title in another case", { artist: "Artist A", title: "song" }],
    ["an artist in another case", { artist: "artist a", title: "Song" }],
    ["a title with a wildcard", { artist: "Artist A", title: "S%" }],
    ["an artist with a wildcard", { artist: "Artist _", title: "Song" }],
    ["a song nobody recorded", { artist: "Artist A", title: "Other Song" }],
  ])("answers the empty element for %s", async (_label, extra) => {
    const response = await lyrics("getLyrics", extra);

    expect(response.status).toBe("ok");
    expect(response.lyrics).toEqual({ value: "" });
  });

  it("renders a miss as an empty element in XML", async () => {
    const xml = await browseXml("/rest/getLyrics", { artist: "Nobody", title: "Nothing" });

    expect(xml).toContain('status="ok"');
    expect(xml).toContain("<lyrics/>");
  });

  it("looks no further back than the newest ten takes", async () => {
    const counted = await lyricsCounting("getLyrics", { artist: "Crowd", title: "Crowded" });

    expect(counted.body.lyrics).toEqual({ value: "" });
    expect(counted.r2Gets).toHaveLength(2 * MAX_LYRICS_CANDIDATES);
    expect(counted.r2Gets).not.toContain(sidecar(CROWD.at(-1) ?? ""));
  });
});

describe("getLyrics without an artist or a title", () => {
  it.each([
    ["no parameters", {}],
    ["no artist", { title: "Song" }],
    ["no title", { artist: "Artist A" }],
    ["a blank artist", { artist: "  ", title: "Song" }],
    ["a blank title", { artist: "Artist A", title: "" }],
  ])("answers the empty element for %s, without a lookup", async (_label, extra) => {
    const counted = await lyricsCounting("getLyrics", extra);

    expect(counted.body.status).toBe("ok");
    expect(counted.body.lyrics).toEqual({ value: "" });
    // Only authentication reached D1.
    expect(counted.statements).toHaveLength(1);
    expect(counted.r2Gets).toEqual([]);
  });
});

describe("what getLyrics costs", () => {
  it("runs one statement besides authentication, and writes nothing", async () => {
    const counted = await lyricsCounting("getLyrics", { artist: "Twins", title: "Twin" });

    expect(counted.body.lyrics?.value).toBe("from the middle take\n");
    expect(counted.statements).toHaveLength(2);
    expect(counted.statements[1]?.bound).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    expect(counted.rowsWritten).toBe(0);
    // The newest take is probed for both suffixes, the middle one answers.
    expect(counted.r2Gets).toEqual([
      sidecar(TWINS[0] ?? ""),
      sidecar(TWINS[0] ?? "", ".txt"),
      sidecar(TWINS[1] ?? ""),
    ]);
  });

  it("stays within twenty R2 reads and writes nothing for a miss", async () => {
    const counted = await lyricsCounting("getLyrics", { artist: "Crowd", title: "Crowded" });

    expect(counted.statements).toHaveLength(2);
    expect(counted.rowsWritten).toBe(0);
    expect(counted.r2Gets.length).toBeLessThanOrEqual(20);
  });
});
