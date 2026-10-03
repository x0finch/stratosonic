import { library, prefixedId } from "@stratosonic/db";
import { asc } from "drizzle-orm";
import type { Context } from "hono";
import { requireFreshSession, requirePermission, requireSession } from "../console-auth/middleware";
import { roleGrants } from "../console-auth/permissions";
import { database } from "../db";
import { NO_USER } from "../library/annotations";
import { albumsQuery, toAlbumViews } from "../library/lists";
import { genresQuery, libraryTotalsQuery, toGenreViews } from "../library/repository";
import {
  ALL_LIBRARIES,
  activeLibrariesScope,
  type LibraryScope,
  librariesScope,
} from "../library/scope";
import {
  type NowPlayingEntry,
  nowPlayingQuery,
  toNowPlayingEntries,
} from "../nowplaying/repository";
import { estimatedPositionMs } from "../nowplaying/session";
import { playlistSummariesQuery } from "../playlists/repository";
import { readScanReport, type ScanReport, scanReportQuery, toScanReport } from "../scanner/state";
import {
  inFlight,
  pokeScanDriver,
  type ScanSchedule,
  scanSchedule,
  tracksOf,
} from "../scanner/status";
import type { ApiApp } from "./app";
import { invalidRequest, limitJsonBody, readJsonObject } from "./json-body";
import { requireSameOrigin } from "./same-origin";

/**
 * The console's Overview (#82, "API: overview"): the library, the scan and
 * who is listening, and the button that starts a scan.
 *
 * Each read is one D1 round trip, a `db.batch` of the statements the
 * Subsonic endpoints answer the same questions from (`getGenres`,
 * `getAlbumList2?type=newest`, `getScanStatus`, `getNowPlaying`), so the
 * console and a Subsonic client see the same library, in the same order.
 * `GET /api/overview/live` is the one the console polls, every 30 s while its
 * tab is visible, so it is the one whose cost matters (#82, "Free-tier
 * budget").
 */

/** How many of the newest albums the overview shows. */
const RECENT_ALBUMS = 12;

export function registerOverviewRoutes(api: ApiApp): void {
  /**
   * `GET /api/overview/library?library=`: counts, genres, the newest albums,
   * every playlist and the libraries, in one batch of five statements.
   * Fetched on page load and when a pass ends, never polled.
   *
   * The genres are `getGenres`' (Navidrome's `GetGenres`), every one, in its
   * order; the albums are the first page of `getAlbumList2?type=newest`, read
   * for no caller, so the annotation join matches nothing (`NO_USER`).
   *
   * `library` (#84, "Console") narrows the counts, the genres and the albums
   * to one library, with its artists counted from its albums
   * (`libraryTotalsQuery`); without it they are every active library's. The
   * playlists are never narrowed. `libraries` lists the active ones, by id,
   * for the console's library switch. A library that is not one of them, or
   * a value that names none, is `404 library_not_found`, found after the
   * batch from the libraries it read, so the check costs no round trip.
   *
   * A library being removed is gone at once (#84, "Removing a library"). The
   * batch learns whether one is, so while every library is active the
   * unnarrowed view runs v0.5.0's SQL in one round trip; while one is
   * removed, its three narrowed statements are read again, kept to the
   * active libraries, in a second.
   */
  api.get("/overview/library", requireSession, requirePermission("library:read"), async (c) => {
    const db = database(c.env);
    const asked = requestedLibrary(c.req.query("library"));
    if (asked === "invalid") {
      return libraryNotFound(c);
    }

    const scope: LibraryScope = asked === null ? ALL_LIBRARIES : librariesScope([asked]);
    const narrowed = (to: LibraryScope) =>
      [
        libraryTotalsQuery(db, to),
        genresQuery(db, to),
        albumsQuery(db, NO_USER, to, { type: "newest" }, { size: RECENT_ALBUMS, offset: 0 }),
      ] as const;
    const [[firstTotals], firstGenres, firstAlbums, playlists, allLibraries] = await db.batch([
      ...narrowed(scope),
      playlistSummariesQuery(db),
      db
        .select({ id: library.id, name: library.name, state: library.state })
        .from(library)
        .orderBy(asc(library.id)),
    ]);
    let [totals, genreRows, albumRows] = [firstTotals, firstGenres, firstAlbums];
    const libraries = allLibraries.filter((entry) => entry.state === "active");
    if (asked !== null && !libraries.some((entry) => entry.id === asked)) {
      return libraryNotFound(c);
    }
    if (asked === null && libraries.length < allLibraries.length) {
      const [[activeTotals], activeGenres, activeAlbums] = await db.batch(
        narrowed(activeLibrariesScope(libraries.map((entry) => entry.id))),
      );
      [totals, genreRows, albumRows] = [activeTotals, activeGenres, activeAlbums];
    }
    const genres = toGenreViews(genreRows);

    return c.json({
      counts: {
        artists: totals?.artists ?? 0,
        albums: totals?.albums ?? 0,
        tracks: totals?.tracks ?? 0,
        genres: genres.length,
        durationSec: totals?.duration ?? 0,
        sizeBytes: totals?.size ?? 0,
      },
      genres: genres.map(({ name, songCount, albumCount }) => ({ name, songCount, albumCount })),
      recentAlbums: toAlbumViews(albumRows).map((album) => ({
        id: prefixedId("album", album.id),
        name: album.name,
        artist: album.albumArtist,
        // An album with no year is Navidrome's year 0, which `<album>` leaves
        // out (library/serializers.ts); here it is null.
        year: album.year || null,
        songCount: album.songCount,
        createdAt: album.createdAt.toISOString(),
      })),
      playlists: playlists.map((entry) => ({
        id: prefixedId("playlist", entry.id),
        name: entry.name,
        owner: entry.owner,
        public: entry.public,
        songCount: entry.songCount,
        durationSec: entry.duration,
        changedAt: entry.changedAt.toISOString(),
      })),
      libraries: libraries.map(({ id, name }) => ({ id, name })),
    });
  });

  /**
   * `GET /api/overview/live`: the scan's status and, for a role that grants
   * `activity:read`, who is listening, in one round trip. The one overview
   * route the console polls.
   *
   * A role without `activity:read` gets `"nowPlaying": null` rather than a
   * 403, so one polled request serves every role, and its statement is not
   * sent at all: the batch is then the scan's one statement.
   */
  api.get("/overview/live", requireSession, requirePermission("library:read"), async (c) => {
    const db = database(c.env);
    const now = Date.now();

    let report: ScanReport;
    let listening: NowPlayingEntry[] | null = null;
    if (roleGrants(c.var.session.role, "activity:read")) {
      const [scanRows, nowPlayingRows] = await db.batch([
        scanReportQuery(db),
        // For no caller, so the song carries nobody's annotation.
        nowPlayingQuery(db, NO_USER, new Date(now)),
      ]);
      report = toScanReport(scanRows);
      listening = toNowPlayingEntries(nowPlayingRows);
    } else {
      report = await readScanReport(db);
    }

    return c.json({
      scan: scanView(report, inFlight(report), scanSchedule(report)),
      nowPlaying: listening?.map((entry) => nowPlayingView(entry, now)) ?? null,
      serverTime: new Date(now).toISOString(),
    });
  });

  /**
   * `POST /api/library/scan` with `{}`: pokes the scan driver exactly as
   * `startScan` does (endpoints/scanning.ts), and answers what the poke did
   * and the scan as `/overview/live` shows it.
   *
   * `scan.running` is `true` whatever the outcome, for `startScan`'s reason:
   * the poke only arms the driver's first alarm, so `ScanProgress` is not
   * written yet, but either outcome means a pass is running. A poke that
   * fails is not swallowed, as it is not in `startScan`: it reaches the error
   * handler, `500 {"error":"internal"}`, rather than a `running` that is not
   * true.
   */
  api.post(
    "/library/scan",
    requireSameOrigin,
    limitJsonBody,
    requireFreshSession,
    requirePermission("library:scan"),
    async (c) => {
      if ((await readJsonObject(c)) === null) {
        return invalidRequest(c);
      }

      const pokedAt = Date.now();
      const outcome = await pokeScanDriver(c.env, pokedAt);
      console.log(
        outcome === "started"
          ? "admin api: a scan was requested; a pass has started"
          : "admin api: a scan was requested; a pass is already running",
      );

      // A pass this poke started is stamped after every change so far, so it
      // covers them; one already in flight is followed by one more if a
      // change came after its start.
      const report = await readScanReport(database(c.env));
      const scheduled =
        outcome === "started" ? scanSchedule(report, true, pokedAt) : scanSchedule(report, true);

      return c.json({ outcome, scan: scanView(report, true, scheduled) });
    },
  );
}

/**
 * The `library` the overview was asked for: null when absent (every library),
 * its id when it is a positive integer, or `"invalid"` for anything else,
 * which names no library.
 */
function requestedLibrary(value: string | undefined): number | null | "invalid" {
  if (value === undefined) {
    return null;
  }
  if (!/^[1-9][0-9]{0,15}$/.test(value)) {
    return "invalid";
  }

  const id = Number(value);

  return Number.isSafeInteger(id) ? id : "invalid";
}

/** `404 library_not_found`: the library asked for is not one the console can show. */
function libraryNotFound(c: Context) {
  return c.json({ error: "library_not_found" }, 404);
}

/**
 * The scan as the console shows it: whether a pass is running and in which
 * phase, how far the scan phase has got, what the last pass found, and the
 * denominator for a progress bar.
 *
 * `progress.tracks` is `getScanStatus`'s `count` during the scan phase
 * (`tracksOf`). R2's listing gives no total, so `estimatedTotal` is the last
 * completed pass's track count, the best guess at how many this one will
 * reach; null before the first pass, when the console shows an indeterminate
 * bar.
 *
 * `scheduled` is what the driver will do about the console's file changes
 * (`scanSchedule`, #83): null when none is pending, a time when a pass
 * starts once the library has been quiet, or `afterCurrentPass` when one
 * more follows the pass in flight. It is read from D1 (`LibraryChangedAt`),
 * so the polled route makes no Durable Object request.
 */
function scanView(report: ScanReport, running: boolean, scheduled: ScanSchedule | null) {
  const { progress, importingPlaylists, lastCompleted } = report;

  return {
    running,
    phase: progress !== null ? "scan" : importingPlaylists ? "playlists" : null,
    progress:
      progress === null
        ? null
        : {
            startedAt: new Date(progress.startedAt).toISOString(),
            tracks: tracksOf(progress.counts),
            examined: progress.counts.examined,
            added: progress.counts.added,
            updated: progress.counts.updated,
            removed: progress.counts.removed,
          },
    estimatedTotal: lastCompleted === null ? null : tracksOf(lastCompleted.counts),
    last:
      lastCompleted === null
        ? null
        : {
            startedAt: new Date(lastCompleted.startedAt).toISOString(),
            finishedAt: new Date(lastCompleted.finishedAt).toISOString(),
            steps: lastCompleted.counts.steps,
            counts: {
              examined: lastCompleted.counts.examined,
              indexed: lastCompleted.counts.indexed,
              added: lastCompleted.counts.added,
              updated: lastCompleted.counts.updated,
              unchanged: lastCompleted.counts.unchanged,
              broken: lastCompleted.counts.broken,
              deferred: lastCompleted.counts.deferred,
              removed: lastCompleted.counts.removed,
              albumsRemoved: lastCompleted.counts.albumsRemoved,
              artistsRemoved: lastCompleted.counts.artistsRemoved,
              coversWritten: lastCompleted.counts.coversWritten,
            },
          },
    scheduled,
  } as const;
}

/**
 * One listener, as `getNowPlaying` reports them (endpoints/playback.ts): the
 * position is moved on to `now` at the session's rate and capped at the
 * track's end (`estimatedPositionMs`), and `serverTime` lets the console keep
 * moving it between polls.
 */
function nowPlayingView({ session, song, username }: NowPlayingEntry, now: number) {
  return {
    username,
    playerName: session.playerName,
    state: session.state,
    positionMs: estimatedPositionMs(session, song.duration, now),
    playbackRate: session.playbackRate,
    startedAt: session.startedAt.toISOString(),
    track: {
      id: prefixedId("track", song.id),
      title: song.title,
      artist: song.artist,
      // Left-joined: a track whose album row a scan has not written yet has
      // no album name, which reads as an empty one.
      album: song.albumName ?? "",
      albumId: prefixedId("album", song.albumId),
      durationSec: song.duration,
    },
  };
}
