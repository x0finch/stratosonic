import { playlistId, prefixedId, trackId } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin } from "./browsing-support";
import { fixtures, fixtureTrack } from "./fixtures/files";
import { adminUserId } from "./lists-support";
import {
  importRun,
  importUntilComplete,
  playlists,
  putPlaylistObject,
  storedEntries,
  storedPlaylists,
} from "./playlists-support";
import { SCAN_TIME, scanUntilComplete, seedFixtureFiles } from "./scan-support";
import { testEnv } from "./support";

/**
 * The playlist import, run against the fixture bucket: what a first pass
 * makes of the committed `.m3u`, what a second pass changes (nothing), what
 * an edited file does, and what happens when a file leaves the bucket.
 *
 * The bucket is seeded and scanned once in `beforeAll`, and each block below
 * changes it and imports again, so the tests read as the history of one
 * library rather than five separate ones. Everything is asserted through the
 * `fetch` handler except the two columns no endpoint renders.
 */

const PLAYLIST = fixtures.playlist;
const PLAYLIST_ID = prefixedId("playlist", playlistId(PLAYLIST.r2Key));

/** The duration the fixture's four matched tracks add up to. */
const MATCHED_DURATION = PLAYLIST.trackKeys
  .map((key) => fixtureTrack(key).duration.seconds)
  .reduce((total, seconds) => total + seconds, 0);

/** A later run, so a rewritten row's timestamps are visibly newer. */
function minutesLater(minutes: number): Date {
  return new Date(SCAN_TIME.getTime() + minutes * 60_000);
}

beforeAll(async () => {
  await bootstrapAdmin();
  await seedFixtureFiles();
  await scanUntilComplete();
});

describe("a first pass over the fixture bucket", () => {
  it("imports the one playlist, and counts the line that names nothing", async () => {
    const run = await importRun();

    expect(run.completed).toBe(true);
    expect(run.counts.imported).toBe(1);
    expect(run.counts.entries).toBe(PLAYLIST.trackKeys.length);
    expect(run.counts.unmatched).toBe(PLAYLIST.unmatchedLineCount);
    expect(run.counts.removed).toBe(0);
    expect(run.counts.deferred).toBe(0);
  });

  it("lists it through getPlaylists, named after its file", async () => {
    const response = await playlists("getPlaylists");
    const listed = response.playlists?.playlist ?? [];

    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(PLAYLIST_ID);
    expect(listed[0]?.name).toBe(PLAYLIST.name);
    expect(listed[0]?.songCount).toBe(PLAYLIST.trackKeys.length);
    expect(listed[0]?.duration).toBe(Math.trunc(MATCHED_DURATION));
    expect(listed[0]?.public).toBe(true);
  });

  it("gives it to the bootstrap admin, and says so", async () => {
    const response = await playlists("getPlaylists");

    expect(response.playlists?.playlist?.[0]?.owner).toBe("admin");
    expect((await storedPlaylists())[0]?.ownerId).toBe(await adminUserId());
  });

  it("dates it by its object rather than by the run", async () => {
    const uploaded = (await testEnv.MUSIC.head(PLAYLIST.r2Key))?.uploaded;
    const listed = (await playlists("getPlaylists")).playlists?.playlist?.[0];

    expect(uploaded).toBeTruthy();
    expect(listed?.created).toBe(uploaded?.toISOString());
    expect(listed?.changed).toBe(uploaded?.toISOString());
  });

  it("returns the matched tracks, in file order, from getPlaylist", async () => {
    const response = await playlists("getPlaylist", { id: PLAYLIST_ID });
    const entries = response.playlist?.entry ?? [];

    expect(entries.map((entry) => entry.id)).toEqual(
      PLAYLIST.trackKeys.map((key) => prefixedId("track", trackId(key))),
    );
    expect(entries.map((entry) => entry.path)).toEqual([...PLAYLIST.trackKeys]);
  });

  it("resolved both the relative and the absolute spelling of a path", async () => {
    const relative = PLAYLIST.lines.find(
      (line) => line.matchesATrack && line.text.startsWith("../"),
    );
    const absolute = PLAYLIST.lines.find((line) => line.matchesATrack && line.text.startsWith("/"));
    const entries = (await playlists("getPlaylist", { id: PLAYLIST_ID })).playlist?.entry ?? [];
    const paths = entries.map((entry) => entry.path);

    expect(paths).toContain(relative?.resolvesTo);
    expect(paths).toContain(absolute?.resolvesTo);
  });

  it("left out the line that names a track the library does not have", async () => {
    const missing = fixtures.playlist.lines.find(
      (line) => line.resolvesTo !== null && !line.matchesATrack,
    );
    const entries = (await playlists("getPlaylist", { id: PLAYLIST_ID })).playlist?.entry ?? [];

    expect(missing?.resolvesTo).toBeTruthy();
    expect(entries.map((entry) => entry.path)).not.toContain(missing?.resolvesTo);
  });

  it("borrows the cover of the first entry whose album has one", async () => {
    const first = fixtureTrack(PLAYLIST.trackKeys[0] ?? "");
    const listed = (await playlists("getPlaylists")).playlists?.playlist?.[0];
    const entry = (await playlists("getPlaylist", { id: PLAYLIST_ID })).playlist?.entry?.[0];

    expect(first.cover).toBeTruthy();
    expect(listed?.coverArt).toBe(entry?.coverArt);
  });

  it("numbers the entries from zero, without gaps", async () => {
    expect((await storedEntries()).map((entry) => entry.position)).toEqual([0, 1, 2, 3]);
  });
});

describe("a second pass over a bucket that has not changed", () => {
  it("leaves every row exactly as it was", async () => {
    const before = { playlists: await storedPlaylists(), entries: await storedEntries() };

    const run = await importRun(minutesLater(15));

    expect(run.completed).toBe(true);
    expect(await storedPlaylists()).toEqual(before.playlists);
    expect(await storedEntries()).toEqual(before.entries);
  });
});

describe("a playlist file that was edited", () => {
  const REVERSED = [...PLAYLIST.trackKeys].reverse().slice(0, 3);

  it("rebuilds the entries in the new order, and renumbers them", async () => {
    await putPlaylistObject(
      PLAYLIST.r2Key,
      `#EXTM3U\n${REVERSED.map((key) => `/${key}`).join("\n")}\n`,
    );

    const run = await importRun(minutesLater(30));

    expect(run.counts.imported).toBe(1);
    expect(run.counts.entries).toBe(REVERSED.length);
    expect(run.counts.unmatched).toBe(0);

    const entries = (await playlists("getPlaylist", { id: PLAYLIST_ID })).playlist?.entry ?? [];
    expect(entries.map((entry) => entry.path)).toEqual(REVERSED);
    expect((await storedEntries()).map((entry) => entry.position)).toEqual([0, 1, 2]);
  });

  it("recomputes the song count and the duration", async () => {
    const listed = (await playlists("getPlaylists")).playlists?.playlist?.[0];
    const seconds = REVERSED.map((key) => fixtureTrack(key).duration.seconds).reduce(
      (total, value) => total + value,
      0,
    );

    expect(listed?.songCount).toBe(REVERSED.length);
    expect(listed?.duration).toBe(Math.trunc(seconds));
  });

  it("moves `changed` to the file's new upload time but leaves `created`", async () => {
    const uploaded = (await testEnv.MUSIC.head(PLAYLIST.r2Key))?.uploaded;
    const listed = (await playlists("getPlaylists")).playlists?.playlist?.[0];

    expect(listed?.changed).toBe(uploaded?.toISOString());
    expect(new Date(listed?.created ?? 0).getTime()).toBeLessThan(uploaded?.getTime() ?? 0);
  });

  it("keeps the same id, because the file is still the same object", async () => {
    expect((await playlists("getPlaylists")).playlists?.playlist?.[0]?.id).toBe(PLAYLIST_ID);
  });
});

describe("a second playlist, named by the file itself", () => {
  const KEY = "playlists/mixed.m3u8";
  const ID = prefixedId("playlist", playlistId(KEY));
  const TRACK = fixtures.tracks[0]?.r2Key ?? "";

  it("takes its name from #PLAYLIST: and reads past a byte-order mark", async () => {
    await putPlaylistObject(KEY, `﻿#EXTM3U\r\n#PLAYLIST:Mixed Bag\r\n${TRACK}\r\n`);

    const run = await importRun(minutesLater(45));

    expect(run.counts.imported).toBe(2);

    const listed = (await playlists("getPlaylists")).playlists?.playlist ?? [];
    expect(listed.find((entry) => entry.id === ID)?.name).toBe("Mixed Bag");
  });

  it("matched a line spelled as a key from the root of the bucket", async () => {
    const entries = (await playlists("getPlaylist", { id: ID })).playlist?.entry ?? [];

    expect(entries.map((entry) => entry.path)).toEqual([TRACK]);
  });

  it("is listed beside the first one, by name", async () => {
    const listed = (await playlists("getPlaylists")).playlists?.playlist ?? [];

    expect(listed.map((entry) => entry.name)).toEqual(["Mixed Bag", PLAYLIST.name]);
  });
});

describe("an import spread over several runs", () => {
  it("finishes the pass across them, and writes the same rows", async () => {
    const before = { playlists: await storedPlaylists(), entries: await storedEntries() };

    const runs = await importUntilComplete({ pageSize: 2, importsPerRun: 1 }, minutesLater(60));

    expect(runs.length).toBeGreaterThan(1);
    expect(runs.at(-1)?.completed).toBe(true);
    expect(runs.at(-1)?.totals.imported).toBe(2);
    expect(await storedPlaylists()).toEqual(before.playlists);
    expect(await storedEntries()).toEqual(before.entries);
  });

  it("left no progress behind once the pass completed", async () => {
    const run = await importRun(minutesLater(75), { pageSize: 2, importsPerRun: 1 });

    // A fresh pass, not the tail of the last one: its own counts are its
    // totals.
    expect(run.counts).toEqual(run.totals);
  });
});

describe("a playlist whose file has left the bucket", () => {
  it("is removed by the sweep, with its entries", async () => {
    await testEnv.MUSIC.delete(PLAYLIST.r2Key);

    const run = await importRun(minutesLater(90));

    expect(run.completed).toBe(true);
    expect(run.counts.removed).toBe(1);

    const listed = (await playlists("getPlaylists")).playlists?.playlist ?? [];
    expect(listed.map((entry) => entry.id)).not.toContain(PLAYLIST_ID);
    expect((await storedEntries()).every((entry) => entry.playlistId !== PLAYLIST_ID)).toBe(true);
  });

  it("answers getPlaylist for it with error 70", async () => {
    const response = await playlists("getPlaylist", { id: PLAYLIST_ID });

    expect(response.status).toBe("failed");
    expect(response.error?.code).toBe(70);
  });
});
