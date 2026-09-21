import { SELF } from "cloudflare:test";
import { albumId, artistId, playlistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import worker from "../src/index";
import { MUSIC_FOLDER_ID, MUSIC_FOLDER_NAME } from "../src/library/music-folder";
import { readLastScanSummary, readScanProgress, type ScanSummary } from "../src/scanner/state";
import type { BrowsingResponse } from "./browsing-support";
import { bootstrapAdmin, browse, browseXml, fixtureAlbum, query } from "./browsing-support";
import type { FixtureAlbum, FixtureTrack } from "./fixtures/files";
import { fixtureBytes, fixtureCoverBytes, fixtures, fixtureTrack } from "./fixtures/files";
import { albumNames, list } from "./lists-support";
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
 * every assertion reads the library through. No row is read or written
 * directly; the only thing taken from D1 is the scan's own summary of a pass,
 * which is a report of the run rather than a statement about the library.
 *
 * The bucket starts with the five audio fixtures and the one `.m3u`, and
 * nothing else: the covers under `_covers/` are what a scan produces. Every
 * expectation comes from `manifest.json`, which the fixture generator writes.
 *
 * The three parts below are the history of one library, in order: it is
 * indexed, it is scanned again and does not move, and then two objects leave
 * the bucket and the library follows.
 */

/** The cron that carries the scan in production, from wrangler.jsonc. */
const CRON = "*/15 * * * *";

/** The instant the first cron run is stamped with. */
const FIRST_RUN = new Date(1_750_000_000_000);

/** The MP3 fixture, whose 3598 bytes make the ranges below meaningful. */
const MP3 = "silent-track.mp3";

/** The FLAC fixture: the second track of a two-track album. */
const FLAC = "hushed-interlude.flac";

/** The album with two tracks, and the artist with two albums. */
const SHARED_ALBUM = "Quiet Album";
const TWO_ALBUM_ARTIST = "Mute Ensemble";

/** How many cron invocations the first pass over the fixtures took. */
let firstPassInvocations = 0;

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
      // A cron run that fails is not retried; the next one resumes the pass.
    },
  };

  await worker.scheduled(controller, testEnv);
}

/**
 * Invokes the cron until the pass it started has finished, and says how many
 * invocations that took. A pass is finished when the scan has left no
 * progress behind and has recorded a summary of this pass — the same two
 * properties the next cron run reads.
 */
async function scheduledUntilComplete(now: Date): Promise<number> {
  const db = database(testEnv);

  // A pass that has not finished after this many runs is a loop, not a scan.
  for (let invocations = 1; invocations <= 20; invocations++) {
    await runScheduled(now);

    const summary = await readLastScanSummary(db);
    if ((await readScanProgress(db)) === null && summary?.startedAt === now.getTime()) {
      return invocations;
    }
  }

  throw new Error("the scheduled entry never completed a pass");
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

/** The album artists the manifest names, once each, in first-seen order. */
function albumArtistNames(): string[] {
  return [...new Set(fixtures.albums.map((album) => album.albumArtist))];
}

/** The artists of `getArtists`, flattened out of their index buckets. */
function artistsOf(body: BrowsingResponse): { name: string; albumCount: number; id: string }[] {
  return (body.artists?.index ?? []).flatMap((index) => index.artist);
}

beforeAll(async () => {
  await bootstrapAdmin();
  await seedFixtureFiles();
  firstPassInvocations = await scheduledUntilComplete(FIRST_RUN);
});

/* ============================================================ the scan == */

describe("the cron indexing a fresh bucket", () => {
  it("finishes the pass in a single invocation at the production limits", () => {
    expect(firstPassInvocations).toBe(1);
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
      expect((body.album?.song ?? []).map((song) => song.duration)).toEqual(
        (body.album?.song ?? []).map((song) => {
          const fixture = tracks.find(
            (entry) => (entry.tags?.title ?? entry.pathFallback.title) === song.title,
          );

          return Math.trunc(fixture?.duration.seconds ?? 0) || undefined;
        }),
      );
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
    const body = await list("getAlbumList2", { type: "newest", size: "50" });
    const listed = body.albumList2?.album ?? [];

    expect(listed.map((album) => album.name).sort()).toEqual(
      fixtures.albums.map((album) => album.name).sort(),
    );

    const created = listed.map((album) => Date.parse(album.created));
    expect(created).toEqual([...created].sort((left, right) => right - left));
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
    ]);
  });
});
