import { SELF } from "cloudflare:test";
import { albumId, artistId, playlistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import worker from "../src/index";
import { MUSIC_FOLDER_ID, MUSIC_FOLDER_NAME } from "../src/library/music-folder";
import { DEFAULT_SCAN_LIMITS } from "../src/scanner/scan";
import { readLastScanSummary, readScanProgress, type ScanSummary } from "../src/scanner/state";
import type { BrowsingResponse } from "./browsing-support";
import { bootstrapAdmin, browse, browseXml, fixtureAlbum, query } from "./browsing-support";
import { driveUntilIdle } from "./driver-support";
import type { FixtureAlbum, FixtureTrack } from "./fixtures/files";
import { fixtureBytes, fixtureCoverBytes, fixtures, fixtureTrack } from "./fixtures/files";
import type { ListsResponse } from "./lists-support";
import { albumNames, list } from "./lists-support";
import type { PlaylistsResponse } from "./playlists-support";
import { playlists } from "./playlists-support";
import { seedFixtureFiles } from "./scan-support";
import { BASE, type JsonEnvelope, testEnv } from "./support";

/**
 * Phase 1, end to end (#18): the bucket is seeded, the cron entry runs, and
 * everything after that is what a client would see.
 *
 * This file is the proof that the parts fit together, so it goes through the
 * two seams and nothing else — the `scheduled` handler exported by
 * `src/index.ts`, exactly as the cron invokes it, and the `fetch` handler
 * every assertion reads the library through. Since #31 the cron only pokes
 * the scan driver, so the steps themselves are the Durable Object's alarms,
 * fired here as soon as each one is scheduled rather than a second apart. No
 * row is read or written directly; the only thing taken from D1 is the scan's
 * own summary of a pass, which is a report of the run rather than a statement
 * about the library.
 *
 * The bucket starts with the five audio fixtures and the one `.m3u`, and
 * nothing else: the covers under `_covers/` are what a scan produces. Every
 * expectation comes from `manifest.json`, which the fixture generator writes.
 *
 * The three parts below are the history of one library, in order: it is
 * indexed, it is scanned again and does not move, and then two objects leave
 * the bucket and the library follows.
 */

/** The cron that pokes the scan driver in production, from wrangler.jsonc. */
const CRON = "*/15 * * * *";

/**
 * The instant the first cron run is stamped with, and the base of the runs
 * after it.
 *
 * It is the real clock rather than a fixed instant, because the bucket's
 * clock is: R2 stamps an object with the time it was really put, a
 * playlist's `created` comes from that stamp, and the playlist sweep only
 * removes rows created before the pass began. A cron pretending to run last
 * year would therefore never sweep a playlist, which is the whole point of
 * the third pass below.
 */
const FIRST_RUN = new Date();

/** The MP3 fixture, whose 3598 bytes make the ranges below meaningful. */
const MP3 = "silent-track.mp3";

/** How many minutes apart the passes in this file are. */
const QUARTER_HOUR = 15 * 60_000;

/** The FLAC fixture: the second track of a two-track album, deleted below. */
const FLAC = "hushed-interlude.flac";

/** The M4A fixture whose album holds nothing else, deleted below. */
const LONE_M4A = "tail-loaded.m4a";

/** The album that survives losing a track, and the one that does not. */
const SHARED_ALBUM = "Quiet Album";
const LONE_ALBUM = "Trailing Sessions";

/** The artist whose two albums become one. */
const TWO_ALBUM_ARTIST = "Mute Ensemble";

/** How many alarm steps the first pass over the fixtures took. */
let firstPassSteps = 0;

/* --------------------------------------------------------- the seams -- */

/**
 * One cron invocation: the real `scheduled` export, with the controller the
 * runtime hands it. A test drives the schedule itself rather than waiting a
 * quarter of an hour between runs.
 */
async function runScheduled(now: Date): Promise<void> {
  const controller: ScheduledController = {
    scheduledTime: now.getTime(),
    cron: CRON,
    noRetry() {
      // A cron run that fails is not retried; the next one pokes again.
    },
  };

  await worker.scheduled(controller, testEnv);
}

/**
 * Pokes the cron and then runs the driver's alarms until the pass it started
 * has finished, and says how many alarms that took (#31).
 *
 * The cron no longer scans: it pokes the scan driver, whose alarm runs one
 * step and schedules the next. A test does not want to wait a second between
 * them, so it fires each alarm itself as soon as the one before it returns —
 * which is also what makes the chain observable, since an alarm that the
 * driver never scheduled cannot be fired.
 *
 * A pass has finished when the driver has stopped, which it says by emptying
 * its own storage; the scan's summary is then checked against the poke, so a
 * driver that gave up part way through is not mistaken for one that
 * finished.
 */
async function scheduledUntilComplete(now: Date): Promise<number> {
  await runScheduled(now);

  // A pass that has not finished after this many alarms is a loop, not a scan.
  const steps = await driveUntilIdle(20);

  const db = database(testEnv);
  const progress = await readScanProgress(db);
  const summary = await readLastScanSummary(db);
  if (progress !== null || summary?.startedAt !== now.getTime()) {
    // `alarm()` logs and swallows a step that throws, so the state the scan
    // left behind is the only account of why the pass is not finished.
    throw new Error(
      `the driver stopped without completing a pass: progress ${JSON.stringify(progress)}, ` +
        `last summary ${JSON.stringify(summary)}`,
    );
  }

  return steps;
}

/** What the pass that began at this instant did, as the scan recorded it. */
async function summaryOf(now: Date): Promise<ScanSummary> {
  const summary = await readLastScanSummary(database(testEnv));
  if (summary?.startedAt !== now.getTime()) {
    throw new Error("no completed pass started at that instant");
  }

  return summary;
}

/* ------------------------------------------------------ what a client asks -- */

function artistUrlId(name: string): string {
  return prefixedId("artist", artistId(name));
}

function albumUrlId(album: FixtureAlbum): string {
  return prefixedId("album", albumId(album.albumArtist, album.name, album.year));
}

function trackUrlId(file: string): string {
  return prefixedId("track", trackId(fixtureTrack(file).r2Key));
}

/**
 * A request for bytes — `stream`, `download`, `getCoverArt` — as a client
 * makes it. `f=json` does not touch the bytes, which are served as
 * themselves; it decides the rendering of the envelope these endpoints fall
 * back to when there is nothing to serve, which is how `errorOf` reads one.
 */
async function fetchBytes(
  endpoint: string,
  extra: Record<string, string>,
  range?: string,
): Promise<Response> {
  return await SELF.fetch(`${BASE}/rest/${endpoint}?${query({ ...extra, f: "json" })}`, {
    headers: range === undefined ? undefined : { Range: range },
  });
}

async function bytesOf(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

/** The failure an endpoint that usually answers with bytes carried instead. */
async function errorOf(response: Response): Promise<{ code: number; message: string } | undefined> {
  const body = (await response.json()) as JsonEnvelope;

  return body["subsonic-response"].error;
}

/** The durations of an album, as the manifest's tracks add up to them. */
function durationOf(tracks: readonly FixtureTrack[]): number {
  return Math.trunc(tracks.reduce((total, entry) => total + entry.duration.seconds, 0));
}

function titlesOf(tracks: readonly FixtureTrack[]): string[] {
  return tracks.map((entry) => entry.tags?.title ?? entry.pathFallback.title).sort();
}

/**
 * What each fixture's `duration` must render as, taken from the manifest
 * rather than from an answer. A `<song>` carries whole seconds, so the
 * fixtures shorter than a second carry no duration at all and the one-second
 * FLAC is the one that proves a duration comes through.
 */
const MANIFEST_DURATIONS = new Map<string, number | undefined>(
  fixtures.tracks.map((entry) => [
    entry.tags?.title ?? entry.pathFallback.title,
    Math.trunc(entry.duration.seconds) || undefined,
  ]),
);

/** The album artists the manifest names, once each, in first-seen order. */
function albumArtistNames(): string[] {
  return [...new Set(fixtures.albums.map((album) => album.albumArtist))];
}

/** The artists of `getArtists`, flattened out of their index buckets. */
function artistsOf(body: BrowsingResponse): { name: string; albumCount: number; id: string }[] {
  return (body.artists?.index ?? []).flatMap((index) => index.artist);
}

/* ------------------------------------------------------------ snapshots -- */

/**
 * Everything a client can see of the library, in one object, so that "a
 * second run changes nothing" can be one comparison rather than twenty.
 *
 * Two endpoints are deliberately absent. `getRandomSongs` answers in a
 * different order every time, by design. `getIndexes` carries
 * `lastModified`, which is when the library was last *scanned* and therefore
 * must move when a pass runs; its artists are compared separately below.
 */
interface LibrarySnapshot {
  readonly artists: BrowsingResponse;
  readonly albums: readonly BrowsingResponse[];
  readonly songs: readonly BrowsingResponse[];
  readonly genres: BrowsingResponse;
  readonly directories: readonly BrowsingResponse[];
  readonly newest: ListsResponse;
  readonly alphabetical: ListsResponse;
  readonly starred: ListsResponse;
  readonly playlists: PlaylistsResponse;
  readonly playlist: PlaylistsResponse;
}

async function librarySnapshot(): Promise<LibrarySnapshot> {
  const albums: BrowsingResponse[] = [];
  for (const album of fixtures.albums) {
    albums.push(await browse("getAlbum", { id: albumUrlId(album) }));
  }

  const songs: BrowsingResponse[] = [];
  for (const fixture of fixtures.tracks) {
    songs.push(await browse("getSong", { id: prefixedId("track", trackId(fixture.r2Key)) }));
  }

  const directories: BrowsingResponse[] = [];
  for (const name of albumArtistNames()) {
    directories.push(await browse("getMusicDirectory", { id: artistUrlId(name) }));
  }

  return {
    artists: await browse("getArtists"),
    albums,
    songs,
    genres: await browse("getGenres"),
    directories,
    newest: await list("getAlbumList2", { type: "newest", size: "50" }),
    alphabetical: await list("getAlbumList2", { type: "alphabeticalByName", size: "50" }),
    starred: await list("getStarred2"),
    playlists: await playlists("getPlaylists"),
    playlist: await playlists("getPlaylist", {
      id: prefixedId("playlist", playlistId(fixtures.playlist.r2Key)),
    }),
  };
}

beforeAll(async () => {
  await bootstrapAdmin();
  await seedFixtureFiles();
  firstPassSteps = await scheduledUntilComplete(FIRST_RUN);
});

/* ============================================================ the scan == */

describe("the cron indexing a fresh bucket", () => {
  it("finishes the pass in one scan step and one import step", async () => {
    // One step is enough for the scan only because the bucket holds no more
    // audio objects than a step may read; a sixth fixture would take a second
    // alarm. The import has the step after it, which is what the driver does
    // when the scan's pass completes.
    //
    // The exact figure is the one the scan recorded itself: the alarms this
    // test fired are only an upper bound, since miniflare fires a due alarm
    // of its own accord too.
    expect(fixtures.tracks.length).toBeLessThanOrEqual(DEFAULT_SCAN_LIMITS.extractionsPerRun);
    expect((await summaryOf(FIRST_RUN)).counts.steps).toBe(1);
    expect(firstPassSteps).toBeLessThanOrEqual(2);
  });

  it("reports a pass that read every fixture and broke on none", async () => {
    const summary = await summaryOf(FIRST_RUN);

    expect(summary.counts.indexed).toBe(fixtures.tracks.length);
    expect(summary.counts.added).toBe(fixtures.tracks.length);
    expect(summary.counts.broken).toBe(0);
    expect(summary.counts.deferred).toBe(0);
    expect(summary.counts.removed).toBe(0);
  });
});

/* ======================================================== browsing == */

describe("browsing the library the cron built", () => {
  it("gives every artist of the manifest the album count it has", async () => {
    const expected = new Map<string, number>();
    for (const album of fixtures.albums) {
      expected.set(album.albumArtist, (expected.get(album.albumArtist) ?? 0) + 1);
    }

    const artists = artistsOf(await browse("getArtists"));

    expect(new Map(artists.map((entry) => [entry.name, entry.albumCount]))).toEqual(expected);
    expect(artists.map((entry) => entry.id)).toEqual(
      artists.map((entry) => artistUrlId(entry.name)),
    );
  });

  // XML for this family: a strict client parses the rendering, not the JSON.
  it("renders getArtist with its albums as XML", async () => {
    const xml = await browseXml("/rest/getArtist", { id: artistUrlId(TWO_ALBUM_ARTIST) });

    expect(xml).toContain('status="ok"');
    expect(xml).toContain(
      `<artist id="${artistUrlId(TWO_ALBUM_ARTIST)}" name="${TWO_ALBUM_ARTIST}"`,
    );
    expect(xml).toContain('albumCount="2"');
    for (const album of fixtures.albums.filter((entry) => entry.albumArtist === TWO_ALBUM_ARTIST)) {
      expect(xml).toContain(`<album id="${albumUrlId(album)}" name="${album.name}"`);
    }
  });

  it.each(fixtures.albums.map((album) => [album.name, album] as const))(
    "shows %s with its tracks and their durations",
    async (_name, album) => {
      const tracks = album.trackFiles.map((file) => fixtureTrack(file));
      const body = await browse("getAlbum", { id: albumUrlId(album) });

      expect(body.album?.songCount).toBe(tracks.length);
      expect(body.album?.duration).toBe(durationOf(tracks));
      expect((body.album?.song ?? []).map((song) => song.title).sort()).toEqual(titlesOf(tracks));

      for (const song of body.album?.song ?? []) {
        expect(song.duration).toBe(MANIFEST_DURATIONS.get(song.title));
      }
    },
  );

  it("describes one track through getSong the way the album lists it", async () => {
    const fixture = fixtureTrack(MP3);
    const body = await browse("getSong", { id: trackUrlId(MP3) });

    expect(body.song?.id).toBe(trackUrlId(MP3));
    expect(body.song?.title).toBe(fixture.tags?.title);
    expect(body.song?.album).toBe(fixture.tags?.album);
    expect(body.song?.isDir).toBe(false);
    expect(body.song?.size).toBe(fixture.size);
    expect(body.song?.suffix).toBe(fixture.suffix);
    expect(body.song?.path).toBe(fixture.r2Key);
  });

  it("lists the genres the fixtures carry, with their counts", async () => {
    const songCounts = new Map<string, number>();
    const albumCounts = new Map<string, number>();
    for (const fixture of fixtures.tracks) {
      const genre = fixture.tags?.genre;
      if (genre) {
        songCounts.set(genre, (songCounts.get(genre) ?? 0) + 1);
      }
    }
    for (const album of fixtures.albums) {
      if (album.genre) {
        albumCounts.set(album.genre, (albumCounts.get(album.genre) ?? 0) + 1);
      }
    }

    const genres = (await browse("getGenres")).genres?.genre ?? [];

    expect(genres.map((genre) => genre.value).sort()).toEqual([...songCounts.keys()].sort());
    for (const genre of genres) {
      expect(genre.songCount).toBe(songCounts.get(genre.value));
      expect(genre.albumCount).toBe(albumCounts.get(genre.value));
    }
  });
});

/* ================================================= folder browsing == */

describe("walking the same library by folder", () => {
  it("offers the one music folder", async () => {
    const body = await browse("getMusicFolders");

    expect(body.musicFolders?.musicFolder).toEqual([
      { id: MUSIC_FOLDER_ID, name: MUSIC_FOLDER_NAME },
    ]);
  });

  it("lists every artist under getIndexes, dated by the pass", async () => {
    const body = await browse("getIndexes");
    const names = (body.indexes?.index ?? []).flatMap((index) =>
      index.artist.map((entry) => entry.name),
    );

    expect(names.sort()).toEqual(albumArtistNames().sort());
    expect(body.indexes?.lastModified).toBe(FIRST_RUN.getTime());
  });

  // XML for this family, where `isDir` being the literal `true` is visible.
  it("renders an artist directory holding its albums as XML", async () => {
    const xml = await browseXml("/rest/getMusicDirectory", { id: artistUrlId(TWO_ALBUM_ARTIST) });

    expect(xml).toContain(
      `<directory id="${artistUrlId(TWO_ALBUM_ARTIST)}" name="${TWO_ALBUM_ARTIST}" albumCount="2">`,
    );
    expect(xml).toContain('isDir="true"');
    expect(xml).not.toContain('isDir="1"');
  });

  it("shows an album directory holding the same tracks getAlbum does", async () => {
    const album = fixtureAlbum(SHARED_ALBUM);
    const tracks = album.trackFiles.map((file) => fixtureTrack(file));
    const body = await browse("getMusicDirectory", { id: albumUrlId(album) });

    expect(body.directory?.name).toBe(album.name);
    expect((body.directory?.child ?? []).map((child) => child.title).sort()).toEqual(
      titlesOf(tracks),
    );
    expect((body.directory?.child ?? []).map((child) => child.isDir)).toEqual(
      tracks.map(() => false),
    );
  });
});

/* ========================================================== media == */

describe("playing what the cron indexed", () => {
  it.each(fixtures.albums.map((album) => [album.name, album] as const))(
    "serves the cover of %s, or says it has none",
    async (_name, album) => {
      const response = await fetchBytes("getCoverArt", { id: albumUrlId(album) });

      if (album.hasCover) {
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe(fixtures.cover.mimeType);
        expect(await bytesOf(response)).toEqual(fixtureCoverBytes());
      } else {
        await expect(errorOf(response)).resolves.toMatchObject({ code: 70 });
      }
    },
  );

  // XML for this family: an error where a client expected an image must still
  // be a readable envelope rather than a few bytes that look like a picture.
  it("renders a missing cover as an XML error 70", async () => {
    const bare = fixtureAlbum("Fallback Album");
    const xml = await browseXml("/rest/getCoverArt", { id: albumUrlId(bare) });

    expect(xml).toContain('<error code="70"');
  });

  it("streams the whole original file", async () => {
    const fixture = fixtureTrack(MP3);
    const response = await fetchBytes("stream", { id: trackUrlId(MP3) });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(fixture.size));
    expect(response.headers.get("Content-Type")).toBe(fixture.contentType);
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await bytesOf(response)).toEqual(fixtureBytes(MP3));
  });

  it("answers a range with 206 and exactly those bytes", async () => {
    const fixture = fixtureTrack(MP3);
    const response = await fetchBytes("stream", { id: trackUrlId(MP3) }, "bytes=100-199");

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 100-199/${fixture.size}`);
    expect(response.headers.get("Content-Length")).toBe("100");
    expect(await bytesOf(response)).toEqual(fixtureBytes(MP3).slice(100, 200));
  });

  it("answers a suffix range from the end of the file", async () => {
    const fixture = fixtureTrack(MP3);
    const response = await fetchBytes("stream", { id: trackUrlId(MP3) }, "bytes=-64");

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(
      `bytes ${fixture.size - 64}-${fixture.size - 1}/${fixture.size}`,
    );
    expect(await bytesOf(response)).toEqual(fixtureBytes(MP3).slice(fixture.size - 64));
  });

  // The acceptance in #1 is that originals play: a client that asks for a
  // transcode is given the file itself, not an error and not silence
  // (ADR-0001).
  it("serves the original FLAC to a client that asked for mp3", async () => {
    const response = await fetchBytes("stream", {
      id: trackUrlId(FLAC),
      format: "mp3",
      maxBitRate: "128",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(fixtureTrack(FLAC).contentType);
    expect(await bytesOf(response)).toEqual(fixtureBytes(FLAC));
  });

  it("downloads the same bytes under the name the file has in R2", async () => {
    const fixture = fixtureTrack(MP3);
    const fileName = fixture.r2Key.split("/").at(-1);
    const response = await fetchBytes("download", { id: trackUrlId(MP3) });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toBe(`attachment; filename="${fileName}"`);
    expect(await bytesOf(response)).toEqual(fixtureBytes(MP3));
  });
});

/* ========================================================== lists == */

describe("the lists a client fills its home screens from", () => {
  it("lists every album under newest, most recent first", async () => {
    // The order to expect is worked out from what `getAlbum` says each album
    // was created at, not from the list's own answer, so a list in the wrong
    // order cannot agree with itself. `newest` is Navidrome's
    // `recently_added` descending — created, then id, both descending — and
    // the fixtures are uploaded in one tight loop, so the id is what tells
    // most of them apart.
    const dated: { id: string; created: number }[] = [];
    for (const album of fixtures.albums) {
      const body = await browse("getAlbum", { id: albumUrlId(album) });
      dated.push({ id: albumUrlId(album), created: Date.parse(body.album?.created ?? "") });
    }
    const expected = [...dated]
      .sort((left, right) => right.created - left.created || (left.id < right.id ? 1 : -1))
      .map((album) => album.id);

    const listed = (await list("getAlbumList2", { type: "newest", size: "50" })).albumList2?.album;

    expect((listed ?? []).map((album) => album.id)).toEqual(expected);
  });

  it("lists every album alphabetically by name", async () => {
    const body = await list("getAlbumList2", { type: "alphabeticalByName", size: "50" });

    expect(albumNames(body)).toEqual(
      fixtures.albums.map((album) => album.name).sort((left, right) => left.localeCompare(right)),
    );
  });

  it("answers getRandomSongs with songs from this library", async () => {
    const body = await list("getRandomSongs", { size: "10" });
    const songs = body.randomSongs?.song ?? [];

    expect(songs).toHaveLength(fixtures.tracks.length);
    expect(songs.map((song) => song.title).sort()).toEqual(titlesOf(fixtures.tracks));
  });

  it("answers getStarred2 with an empty, valid list", async () => {
    const body = await list("getStarred2");

    expect(body.status).toBe("ok");
    expect(body.error).toBeUndefined();
    expect(body.starred2?.artist).toBeUndefined();
    expect(body.starred2?.album).toBeUndefined();
    expect(body.starred2?.song).toBeUndefined();
  });

  // XML for this family: an empty list must be a childless element, not an
  // error and not a missing one — a client stops syncing over either.
  it("renders the empty getStarred2 as a childless XML element", async () => {
    const xml = await browseXml("/rest/getStarred2");

    expect(xml).toContain("<starred2/>");
    expect(xml).not.toContain("<error");
  });
});

/* ====================================================== playlists == */

describe("the playlist the cron imported", () => {
  const playlistUrlId = prefixedId("playlist", playlistId(fixtures.playlist.r2Key));

  it("lists it, named after its file, counting only the lines that matched", async () => {
    const listed = (await playlists("getPlaylists")).playlists?.playlist ?? [];

    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(playlistUrlId);
    expect(listed[0]?.name).toBe(fixtures.playlist.name);
    expect(listed[0]?.songCount).toBe(fixtures.playlist.trackKeys.length);
    expect(listed[0]?.owner).toBe("admin");
  });

  it("returns its entries in the order the file lists them", async () => {
    const body = await playlists("getPlaylist", { id: playlistUrlId });

    expect((body.playlist?.entry ?? []).map((entry) => entry.id)).toEqual(
      fixtures.playlist.trackKeys.map((key) => prefixedId("track", trackId(key))),
    );
  });

  // XML for this family: the entry order is the point, and it is the document
  // order a client reads it in.
  it("renders those entries in the same order as XML", async () => {
    const xml = await browseXml("/rest/getPlaylist", { id: playlistUrlId });
    const ids = [...xml.matchAll(/<entry id="([^"]+)"/g)].map((match) => match[1]);

    expect(ids).toEqual(
      fixtures.playlist.trackKeys.map((key) => prefixedId("track", trackId(key))),
    );
  });
});

/* ========================================================= system == */

describe("the calls a client makes before anything else", () => {
  it("answers ping as XML, the default rendering", async () => {
    const xml = await browseXml("/rest/ping");

    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('status="ok"');
  });

  it("declares the OpenSubsonic extensions it supports", async () => {
    const response = await SELF.fetch(
      `${BASE}/rest/getOpenSubsonicExtensions?${query({ f: "json" })}`,
    );
    const body = (await response.json()) as JsonEnvelope;

    expect(body["subsonic-response"].status).toBe("ok");
    expect(body["subsonic-response"].openSubsonic).toBe(true);
    expect(body["subsonic-response"].openSubsonicExtensions).toEqual([
      { name: "formPost", versions: [1] },
      { name: "songLyrics", versions: [1] },
    ]);
  });
});

/* =================================================== a second pass == */

describe("a second cron run over the unchanged bucket", () => {
  const secondRun = new Date(FIRST_RUN.getTime() + QUARTER_HOUR);

  it("leaves every response a client can ask for exactly as it was", async () => {
    const before = await librarySnapshot();
    const indexedBefore = await browse("getIndexes");

    expect(await scheduledUntilComplete(secondRun)).toBeLessThanOrEqual(2);
    expect((await summaryOf(secondRun)).counts.steps).toBe(1);

    expect(await librarySnapshot()).toEqual(before);
    // `getIndexes` carries when the library was last scanned, which has to
    // move; its artists are the part that must not.
    expect((await browse("getIndexes")).indexes?.index).toEqual(indexedBefore.indexes?.index);
  });

  it("reports a pass that read nothing and removed nothing", async () => {
    const summary = await summaryOf(secondRun);

    expect(summary.counts.steps).toBe(1);
    expect(summary.counts.indexed).toBe(0);
    expect(summary.counts.added).toBe(0);
    expect(summary.counts.updated).toBe(0);
    expect(summary.counts.unchanged).toBe(fixtures.tracks.length);
    expect(summary.counts.coversWritten).toBe(0);
    expect(summary.counts.removed).toBe(0);
    expect(summary.counts.albumsRemoved).toBe(0);
  });
});

/* ============================== a track and a playlist leave the bucket == */

describe("deleting one track and the .m3u, then rescanning", () => {
  const thirdRun = new Date(FIRST_RUN.getTime() + 2 * QUARTER_HOUR);
  const album = fixtureAlbum(SHARED_ALBUM);
  /** The track that stays behind in that album. */
  const remaining = album.trackFiles
    .filter((file) => file !== FLAC)
    .map((file) => fixtureTrack(file));

  beforeAll(async () => {
    await testEnv.MUSIC.delete(fixtureTrack(FLAC).r2Key);
    await testEnv.MUSIC.delete(fixtures.playlist.r2Key);
    await scheduledUntilComplete(thirdRun);
  });

  it("reports the pass that removed it", async () => {
    const summary = await summaryOf(thirdRun);

    expect(summary.counts.removed).toBe(1);
    expect(summary.counts.albumsRemoved).toBe(0);
    expect(summary.counts.artistsRemoved).toBe(0);
  });

  it("drops the track from its album and adds the album up again", async () => {
    const body = await browse("getAlbum", { id: albumUrlId(album) });

    expect(body.album?.songCount).toBe(remaining.length);
    expect(body.album?.duration).toBe(durationOf(remaining));
    expect((body.album?.song ?? []).map((song) => song.title).sort()).toEqual(titlesOf(remaining));
  });

  it("answers getSong and stream for the deleted track with error 70", async () => {
    const body = await browse("getSong", { id: trackUrlId(FLAC) });
    expect(body.error?.code).toBe(70);

    const response = await fetchBytes("stream", { id: trackUrlId(FLAC) });
    await expect(errorOf(response)).resolves.toMatchObject({ code: 70 });
  });

  it("keeps the album, its cover and its artist's album count", async () => {
    const cover = await fetchBytes("getCoverArt", { id: albumUrlId(album) });
    expect(cover.status).toBe(200);
    expect(await bytesOf(cover)).toEqual(fixtureCoverBytes());

    const artists = artistsOf(await browse("getArtists"));
    expect(artists.find((entry) => entry.name === album.albumArtist)?.albumCount).toBe(1);
  });

  it("drops the track from the folder view and from the random songs", async () => {
    const directory = await browse("getMusicDirectory", { id: albumUrlId(album) });
    expect((directory.directory?.child ?? []).map((child) => child.title).sort()).toEqual(
      titlesOf(remaining),
    );

    const songs = (await list("getRandomSongs", { size: "50" })).randomSongs?.song ?? [];
    expect(songs.map((song) => song.id)).not.toContain(trackUrlId(FLAC));
  });

  it("removes the playlist whose file is gone", async () => {
    const playlistUrlId = prefixedId("playlist", playlistId(fixtures.playlist.r2Key));

    expect((await playlists("getPlaylists")).playlists?.playlist).toBeUndefined();
    expect((await playlists("getPlaylist", { id: playlistUrlId })).error?.code).toBe(70);
  });
});

/* ============================= an album loses its only track == */

describe("deleting the only track of an album, then rescanning", () => {
  const fourthRun = new Date(FIRST_RUN.getTime() + 3 * QUARTER_HOUR);
  const album = fixtureAlbum(LONE_ALBUM);

  beforeAll(async () => {
    await testEnv.MUSIC.delete(fixtureTrack(LONE_M4A).r2Key);
    await scheduledUntilComplete(fourthRun);
  });

  it("reports the pass that pruned the emptied album", async () => {
    const summary = await summaryOf(fourthRun);

    expect(summary.counts.removed).toBe(1);
    expect(summary.counts.albumsRemoved).toBe(1);
    expect(summary.counts.artistsRemoved).toBe(0);
  });

  it("answers getAlbum and getCoverArt for it with error 70", async () => {
    expect((await browse("getAlbum", { id: albumUrlId(album) })).error?.code).toBe(70);

    const cover = await fetchBytes("getCoverArt", { id: albumUrlId(album) });
    await expect(errorOf(cover)).resolves.toMatchObject({ code: 70 });
  });

  it("takes it out of the album lists and off its artist", async () => {
    const listed = await list("getAlbumList2", { type: "alphabeticalByName", size: "50" });
    expect(albumNames(listed)).not.toContain(album.name);

    const artists = artistsOf(await browse("getArtists"));
    expect(artists.find((entry) => entry.name === TWO_ALBUM_ARTIST)?.albumCount).toBe(1);
  });

  it("keeps the artist, with only the album it still has, in the folder view", async () => {
    const body = await browse("getMusicDirectory", { id: artistUrlId(TWO_ALBUM_ARTIST) });
    const children = body.directory?.child ?? [];

    expect(children.map((child) => child.name)).toEqual(["Faststart Sessions"]);
    expect(body.directory?.albumCount).toBe(1);
  });
});
