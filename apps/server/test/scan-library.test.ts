import { SELF } from "cloudflare:test";
import { albumId, artistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { audioContentType } from "../src/library/audio-formats";
import { readLastScanSummary, readScanProgress } from "../src/scanner/state";
import { bootstrapAdmin, browse, fixtureAlbum, query } from "./browsing-support";
import { fixtureCoverBytes, fixtures, fixtureTrack } from "./fixtures/files";
import {
  bucketKeys,
  coverUploads,
  listedObjects,
  SCAN_TIME,
  scan,
  seedFixtureFiles,
  storedTracks,
} from "./scan-support";
import { BASE, fixtureCoverKey, testEnv } from "./support";

/**
 * A full pass over the fixture bucket, seen the way a client sees it.
 *
 * The bucket holds the five audio fixtures and the `.m3u`, and nothing else:
 * no rows, and no cover objects, because producing those is the scan's job.
 * Every expectation comes from `manifest.json`, which the fixture generator
 * writes; nothing here restates what a fixture contains.
 */

beforeAll(async () => {
  await bootstrapAdmin();
  await seedFixtureFiles();
});

describe("a first scan of the fixture bucket", () => {
  it("completes in one run and indexes every fixture track", async () => {
    const run = await scan();

    expect(run.completed).toBe(true);
    expect(run.counts.indexed).toBe(fixtures.tracks.length);
    expect(run.counts.added).toBe(fixtures.tracks.length);
    expect(run.counts.updated).toBe(0);
    expect(run.counts.broken).toBe(0);
    expect(run.counts.deferred).toBe(0);
  });

  it("indexes the audio objects and nothing else in the bucket", async () => {
    expect((await storedTracks()).map((row) => row.r2Key)).toEqual(
      fixtures.tracks.map((fixture) => fixture.r2Key).sort(),
    );
  });

  it("gives every artist of the manifest the album count it has", async () => {
    const body = await browse("getArtists");
    const artists = (body.artists?.index ?? []).flatMap((index) => index.artist);

    const expected = new Map<string, number>();
    for (const album of fixtures.albums) {
      expected.set(album.albumArtist, (expected.get(album.albumArtist) ?? 0) + 1);
    }

    expect(new Map(artists.map((entry) => [entry.name, entry.albumCount]))).toEqual(expected);
    expect(artists.map((entry) => entry.id)).toEqual(
      artists.map((entry) => prefixedId("artist", artistId(entry.name))),
    );
  });

  it.each(fixtures.albums.map((album) => [album.name, album] as const))(
    "adds %s up from its tracks",
    async (_name, album) => {
      const tracks = album.trackFiles.map((file) => fixtureTrack(file));
      const body = await browse("getAlbum", {
        id: prefixedId("album", albumId(album.albumArtist, album.name, album.year)),
      });

      expect(body.album?.songCount).toBe(tracks.length);
      expect(body.album?.duration).toBe(
        Math.trunc(tracks.reduce((total, entry) => total + entry.duration.seconds, 0)),
      );
      expect(body.album?.artist).toBe(album.albumArtist);
      expect(body.album?.year).toBe(album.year ?? undefined);
      expect(body.album?.genre).toBe(album.genre ?? undefined);
      expect(body.album?.coverArt).toBe(
        album.hasCover
          ? prefixedId("album", albumId(album.albumArtist, album.name, album.year))
          : undefined,
      );
      expect((body.album?.song ?? []).map((song) => song.title).sort()).toEqual(
        tracks.map((entry) => entry.tags?.title ?? entry.pathFallback.title).sort(),
      );
    },
  );

  it.each(fixtures.tracks.map((fixture) => [fixture.file, fixture] as const))(
    "describes %s from the tags and the object",
    async (_file, fixture) => {
      const body = await browse("getSong", {
        id: prefixedId("track", trackId(fixture.r2Key)),
      });

      expect(body.song?.title).toBe(fixture.tags?.title ?? fixture.pathFallback.title);
      expect(body.song?.artist).toBe(fixture.tags?.artist ?? fixture.pathFallback.albumArtist);
      expect(body.song?.album).toBe(fixture.tags?.album ?? fixture.pathFallback.album);
      expect(body.song?.path).toBe(fixture.r2Key);
      expect(body.song?.suffix).toBe(fixture.suffix);
      expect(body.song?.contentType).toBe(audioContentType(fixture.suffix));
      expect(body.song?.size).toBe(fixture.size);
      expect(body.song?.bitRate).toBe(fixture.bitRate.kbps);
      expect(body.song?.duration).toBe(Math.trunc(fixture.duration.seconds) || undefined);
      expect(body.song?.year).toBe(fixture.tags?.year ?? undefined);
      expect(body.song?.genre).toBe(fixture.tags?.genre ?? undefined);
      expect(body.song?.track).toBe(fixture.tags?.trackNumber ?? undefined);
      expect(body.song?.discNumber).toBe(fixture.tags?.discNumber ?? undefined);
    },
  );

  it("stores the etag, size and upload time it will compare against next run", async () => {
    const listed = await listedObjects();

    for (const row of await storedTracks()) {
      const object = listed.get(row.r2Key);

      expect(object).toBeDefined();
      expect(row.etag).toBe(object?.etag);
      expect(row.size).toBe(object?.size);
      expect(row.createdAt.getTime()).toBe(object?.uploaded.getTime());
      expect(row.updatedAt.getTime()).toBe(SCAN_TIME.getTime());
    }
  });

  it("writes one cover per album that has one, and none for the album that has not", async () => {
    expect(await bucketKeys("_covers/")).toEqual(
      fixtures.albums
        .map((album) => fixtureCoverKey(album))
        .filter((key): key is string => key !== null)
        .sort(),
    );
  });

  it("serves a written cover as the image its tag declared", async () => {
    const album = fixtureAlbum("Quiet Album");
    const response = await SELF.fetch(
      `${BASE}/rest/getCoverArt?${query({
        id: prefixedId("album", albumId(album.albumArtist, album.name, album.year)),
      })}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(fixtures.cover.mimeType);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(fixtureCoverBytes());
  });

  it("leaves a summary of the pass behind and no progress", async () => {
    const db = database(testEnv);

    expect(await readScanProgress(db)).toBeNull();

    const summary = await readLastScanSummary(db);
    expect(summary?.startedAt).toBe(SCAN_TIME.getTime());
    expect(summary?.finishedAt).toBe(SCAN_TIME.getTime());
    expect(summary?.counts.indexed).toBe(fixtures.tracks.length);
    expect(summary?.counts.removed).toBe(0);
  });

  it("dates the library for `getIndexes` with when the pass started", async () => {
    const body = await browse("getIndexes");

    expect(body.indexes?.lastModified).toBe(SCAN_TIME.getTime());
  });
});

describe("a second scan of an unchanged bucket", () => {
  it("reads no object, writes no row and rewrites no cover", async () => {
    const tracksBefore = await storedTracks();
    const coversBefore = await coverUploads();

    const run = await scan(new Date(SCAN_TIME.getTime() + 60_000));

    expect(run.completed).toBe(true);
    expect(run.counts.unchanged).toBe(fixtures.tracks.length);
    expect(run.counts.indexed).toBe(0);
    expect(run.counts.coversWritten).toBe(0);
    expect(run.counts.removed).toBe(0);
    expect(run.counts.albumsRemoved).toBe(0);
    expect(run.counts.artistsRemoved).toBe(0);
    expect(await storedTracks()).toEqual(tracksBefore);
    expect(await coverUploads()).toEqual(coversBefore);
  });
});
