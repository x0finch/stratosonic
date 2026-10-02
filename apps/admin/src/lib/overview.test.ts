import {
  environmentManager,
  focusManager,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LibraryOverview, LiveOverview, ScanStatus } from "@/lib/api";
import {
  afterScanRequest,
  describeSchedule,
  estimatePositionMs,
  followLive,
  LIVE_INTERVAL_IDLE_MS,
  LIVE_INTERVAL_SCANNING_MS,
  type LiveRead,
  libraryQuery,
  liveQuery,
  liveRefetchInterval,
  passEnded,
  USAGE_INTERVAL_MS,
  usageQuery,
} from "@/lib/overview";

const IDLE: ScanStatus = {
  running: false,
  phase: null,
  progress: null,
  estimatedTotal: 120,
  last: null,
  scheduled: null,
};

function live(running: boolean): LiveRead {
  return {
    scan: { ...IDLE, running, phase: running ? "scan" : null },
    nowPlaying: [],
    serverTime: "2026-10-01T12:00:00.000Z",
    receivedAt: 1_000,
  };
}

/** The same read, with a last completed pass that finished at `finishedAt`. */
function finished(read: LiveRead, finishedAt: string): LiveRead {
  const counts = {
    examined: 0,
    indexed: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    broken: 0,
    deferred: 0,
    removed: 0,
    albumsRemoved: 0,
    artistsRemoved: 0,
    coversWritten: 0,
  };
  return {
    ...read,
    scan: { ...read.scan, last: { startedAt: finishedAt, finishedAt, steps: 1, counts } },
  };
}

const LIBRARY: LibraryOverview = {
  counts: { artists: 1, albums: 1, tracks: 1, genres: 0, durationSec: 1, sizeBytes: 1 },
  genres: [],
  recentAlbums: [],
  playlists: [],
};

/** A client holding a fresh library read, as the Overview has after its first load. */
function clientWithLibrary(): QueryClient {
  const queryClient = new QueryClient();
  queryClient.setQueryData(libraryQuery.queryKey, LIBRARY);
  return queryClient;
}

function libraryIsStale(queryClient: QueryClient): boolean {
  return queryClient.getQueryState(libraryQuery.queryKey)?.isInvalidated ?? false;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the live route's polling interval", () => {
  it("is 10 s while a pass is in flight", () => {
    expect(liveRefetchInterval(live(true))).toBe(10_000);
    expect(LIVE_INTERVAL_SCANNING_MS).toBe(10_000);
  });

  it("is 30 s otherwise, and before the first read", () => {
    expect(liveRefetchInterval(live(false))).toBe(30_000);
    expect(liveRefetchInterval(undefined)).toBe(LIVE_INTERVAL_IDLE_MS);
    expect(LIVE_INTERVAL_IDLE_MS).toBe(30_000);
  });

  it("is what the live query polls at, and nothing is read while the tab is hidden", async () => {
    // Node has no window, which TanStack Query takes for a server, where it
    // schedules no interval at all: this test is the browser.
    environmentManager.setIsServer(() => false);
    vi.useFakeTimers();
    let running = false;
    const fetch = vi.fn(async () => {
      const { receivedAt: _, ...body } = live(running);
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    // Mounted, as QueryClientProvider mounts it, so it follows focusManager.
    const queryClient = new QueryClient();
    queryClient.mount();
    const observer = new QueryObserver(queryClient, liveQuery);
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);

      // Idle: one read every 30 s.
      await vi.advanceTimersByTimeAsync(29_000);
      expect(fetch).toHaveBeenCalledTimes(1);
      running = true;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetch).toHaveBeenCalledTimes(2);

      // That read says a pass is running: one every 10 s.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetch).toHaveBeenCalledTimes(3);

      // A hidden tab reads nothing, however long it stays hidden.
      focusManager.setFocused(false);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(fetch).toHaveBeenCalledTimes(3);

      // Back on screen, it reads at once.
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      unsubscribe();
      queryClient.unmount();
      focusManager.setFocused(undefined);
      environmentManager.setIsServer(() => typeof window === "undefined");
      vi.useRealTimers();
    }
    expect(liveQuery.staleTime).toBe(0);
    expect(liveQuery.refetchIntervalInBackground).toBe(false);
  });

  it("leaves the library unpolled, and polls usage every 5 minutes", () => {
    expect(libraryQuery).not.toHaveProperty("refetchInterval");
    expect(libraryQuery.staleTime).toBe(5 * 60_000);
    expect(usageQuery.refetchInterval).toBe(USAGE_INTERVAL_MS);
    expect(usageQuery.staleTime).toBe(5 * 60_000);
    expect(usageQuery.refetchIntervalInBackground).toBe(false);
  });

  it("stamps each read with when it arrived", async () => {
    const { receivedAt: _, ...body } = live(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
    vi.spyOn(Date, "now").mockReturnValue(42_000);

    const read = await new QueryClient().fetchQuery(liveQuery);

    expect(read).toEqual({ ...body, receivedAt: 42_000 });
    vi.restoreAllMocks();
  });
});

describe("a tab coming back after a while hidden", () => {
  /**
   * The Overview's live and library reads, on a fake clock, against a
   * server whose last completed pass is `last.finishedAt`. Answers how often
   * each route was read.
   */
  async function hideFor(minutes: number, passMeanwhile: boolean) {
    environmentManager.setIsServer(() => false);
    vi.useFakeTimers();
    let finishedAt = "2026-10-01T11:00:00.000Z";
    const reads = { live: 0, library: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/overview/library") {
          reads.library += 1;
          return new Response(JSON.stringify(LIBRARY), { status: 200 });
        }
        reads.live += 1;
        const { receivedAt: _, ...body } = finished(live(false), finishedAt);
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const queryClient = new QueryClient();
    queryClient.mount();
    const observers = [
      new QueryObserver(queryClient, liveQuery),
      new QueryObserver(queryClient, libraryQuery),
    ];
    const unsubscribe = observers.map((observer) => observer.subscribe(() => {}));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toEqual({ live: 1, library: 1 });

      focusManager.setFocused(false);
      if (passMeanwhile) {
        finishedAt = "2026-10-01T11:15:00.000Z";
      }
      await vi.advanceTimersByTimeAsync(minutes * 60_000);
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(0);
      return reads;
    } finally {
      for (const stop of unsubscribe) {
        stop();
      }
      queryClient.unmount();
      focusManager.setFocused(undefined);
      environmentManager.setIsServer(() => typeof window === "undefined");
      vi.useRealTimers();
    }
  }

  it("reads the live route again, and not the library when no pass ended", async () => {
    expect(libraryQuery.refetchOnWindowFocus).toBe(false);
    expect(await hideFor(20, false)).toEqual({ live: 2, library: 1 });
  });

  it("reads the library again when a pass ended meanwhile", async () => {
    expect(await hideFor(20, true)).toEqual({ live: 2, library: 2 });
  });
});

describe("the end of a pass", () => {
  it("is running turning from true to false", () => {
    expect(passEnded(live(true), live(false))).toBe(true);
  });

  it("is a new last pass that no read saw running, as a cron pass in a hidden tab", () => {
    const before = finished(live(false), "2026-10-01T11:00:00.000Z");
    expect(passEnded(before, finished(live(false), "2026-10-01T11:15:00.000Z"))).toBe(true);
    expect(passEnded(live(false), finished(live(false), "2026-10-01T11:15:00.000Z"))).toBe(true);
    expect(passEnded(before, finished(live(false), "2026-10-01T11:00:00.000Z"))).toBe(false);
  });

  it("waits for a pass's playlists, which import after its summary is written", () => {
    const before = finished(live(false), "2026-10-01T11:00:00.000Z");
    const importing = finished(live(true), "2026-10-01T11:15:00.000Z");

    expect(passEnded(before, importing)).toBe(false);
    expect(passEnded(importing, finished(live(false), "2026-10-01T11:15:00.000Z"))).toBe(true);
  });

  it("is nothing else", () => {
    expect(passEnded(undefined, live(false))).toBe(false);
    expect(passEnded(undefined, live(true))).toBe(false);
    expect(passEnded(live(false), live(false))).toBe(false);
    expect(passEnded(live(false), live(true))).toBe(false);
    expect(passEnded(live(true), live(true))).toBe(false);
    expect(passEnded(live(true), undefined)).toBe(false);
  });

  it("reads the library again", () => {
    const queryClient = clientWithLibrary();

    expect(followLive(queryClient, live(true), live(false))).toBe(true);
    expect(libraryIsStale(queryClient)).toBe(true);
  });

  it("is seen by the live query itself, from the read before", async () => {
    const queryClient = clientWithLibrary();
    queryClient.setQueryData(liveQuery.queryKey, live(true));
    const { receivedAt: _, ...ended } = live(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(ended), { status: 200 })),
    );

    await queryClient.fetchQuery(liveQuery);
    expect(libraryIsStale(queryClient)).toBe(true);

    // The next idle read ends nothing more.
    await queryClient.fetchQuery({ ...libraryQuery, staleTime: 0 });
    expect(libraryIsStale(queryClient)).toBe(false);
    await queryClient.fetchQuery({ ...liveQuery, staleTime: 0 });
    expect(libraryIsStale(queryClient)).toBe(false);
  });

  it("leaves the library alone while nothing ended", () => {
    const queryClient = clientWithLibrary();

    expect(followLive(queryClient, live(false), live(true))).toBe(false);
    expect(followLive(queryClient, live(true), live(true))).toBe(false);
    expect(followLive(queryClient, undefined, live(false))).toBe(false);
    expect(libraryIsStale(queryClient)).toBe(false);
  });
});

describe("a scan request", () => {
  it("puts the answer's scan in the live read, keeping its anchor, and reads the library again", () => {
    const queryClient = clientWithLibrary();
    const before = { ...live(false), receivedAt: 7_000 };
    queryClient.setQueryData(liveQuery.queryKey, before);
    const scan: ScanStatus = { ...IDLE, running: true };

    afterScanRequest(queryClient, { outcome: "started", scan });

    const after = queryClient.getQueryData(liveQuery.queryKey);
    expect(after).toEqual({ ...before, scan });
    expect(liveRefetchInterval(after)).toBe(LIVE_INTERVAL_SCANNING_MS);
    expect(libraryIsStale(queryClient)).toBe(true);
  });

  it("leaves a live route not yet read to its first read", () => {
    const queryClient = clientWithLibrary();

    afterScanRequest(queryClient, { outcome: "running", scan: { ...IDLE, running: true } });

    expect(queryClient.getQueryData(liveQuery.queryKey)).toBeUndefined();
  });
});

describe("the scan's schedule, in words", () => {
  /** The server's clock at the live read. */
  const server = Date.parse("2026-10-02T12:00:00.000Z");
  /** A read that arrived at once, on a browser whose clock agrees. */
  const inSync = { serverTime: new Date(server).toISOString(), receivedAt: server };
  const at = (offsetMs: number): ScanStatus => ({
    ...IDLE,
    scheduled: { scheduledAt: new Date(server + offsetMs).toISOString(), afterCurrentPass: false },
  });

  it("says nothing when no pass is scheduled", () => {
    expect(describeSchedule(IDLE, inSync, server)).toBeNull();
  });

  it("says when a pass starts, in whole minutes", () => {
    expect(describeSchedule(at(120_000), inSync, server)).toBe(
      "A scan is scheduled in about 2 minutes.",
    );
    expect(describeSchedule(at(100_000), inSync, server)).toBe(
      "A scan is scheduled in about 2 minutes.",
    );
    expect(describeSchedule(at(80_000), inSync, server)).toBe(
      "A scan is scheduled in about a minute.",
    );
    expect(describeSchedule(at(5_000), inSync, server)).toBe(
      "A scan is scheduled in about a minute.",
    );
  });

  it("says a pass is starting once its time has come", () => {
    expect(describeSchedule(at(0), inSync, server)).toBe("A scan is starting.");
    expect(describeSchedule(at(-30_000), inSync, server)).toBe("A scan is starting.");
  });

  it("counts the time left on the server's clock, whatever the browser's says", () => {
    // Due 150 s after the read; 30 s later, by the browser's own count, 120 s
    // are left, with the browser's clock ten minutes behind or ahead.
    const scan = at(150_000);
    for (const skew of [-600_000, 600_000]) {
      const receivedAt = server + skew;
      const clock = { serverTime: inSync.serverTime, receivedAt };

      expect(describeSchedule(scan, clock, receivedAt + 30_000)).toBe(
        "A scan is scheduled in about 2 minutes.",
      );
      expect(describeSchedule(scan, clock, receivedAt + 160_000)).toBe("A scan is starting.");
    }
  });

  it("says only that a scan is running when the pass in flight covers the change", () => {
    const scan: ScanStatus = {
      ...IDLE,
      running: true,
      phase: "scan",
      scheduled: { scheduledAt: null, afterCurrentPass: false },
    };
    expect(describeSchedule(scan, inSync, server)).toBe("A scan is running.");
  });

  it("says another pass follows the one running", () => {
    const scan: ScanStatus = {
      ...IDLE,
      running: true,
      phase: "scan",
      scheduled: { scheduledAt: null, afterCurrentPass: true },
    };
    expect(describeSchedule(scan, inSync, server)).toBe(
      "A scan is running. Another follows it for recent file changes.",
    );
  });
});

describe("the local position estimate", () => {
  const track = { durationSec: 240 };
  const playing = { state: "playing" as const, positionMs: 60_000, playbackRate: 1, track };

  it("moves a playing session on by the time since the read arrived", () => {
    expect(estimatePositionMs(playing, 1_000, 1_000)).toBe(60_000);
    expect(estimatePositionMs(playing, 1_000, 13_500)).toBe(72_500);
  });

  it("moves at the session's rate", () => {
    expect(estimatePositionMs({ ...playing, playbackRate: 1.5 }, 0, 10_000)).toBe(75_000);
    expect(estimatePositionMs({ ...playing, playbackRate: 0.5 }, 0, 10_001)).toBe(65_000);
  });

  it("stops at the end of the track", () => {
    expect(estimatePositionMs(playing, 0, 600_000)).toBe(240_000);
    expect(estimatePositionMs({ ...playing, track: { durationSec: 241.3456 } }, 0, 600_000)).toBe(
      241_345,
    );
  });

  it("leaves a paused or starting session where it is", () => {
    expect(estimatePositionMs({ ...playing, state: "paused" }, 0, 30_000)).toBe(60_000);
    expect(estimatePositionMs({ ...playing, state: "starting" }, 0, 30_000)).toBe(60_000);
  });

  it("never moves a session back when this clock steps back", () => {
    expect(estimatePositionMs(playing, 10_000, 4_000)).toBe(60_000);
  });

  it("does not depend on how far this clock is from the server's", () => {
    // `serverTime` says noon; this browser's clock is an hour behind. Only
    // the time since the read arrived counts.
    const read: LiveOverview = { ...live(false), serverTime: "2026-10-01T12:00:00.000Z" };
    const receivedAt = Date.parse(read.serverTime) - 3_600_000;

    expect(estimatePositionMs(playing, receivedAt, receivedAt + 5_000)).toBe(65_000);
  });
});
