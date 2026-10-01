import { type QueryClient, queryOptions } from "@tanstack/react-query";

import {
  fetchLibraryOverview,
  fetchLiveOverview,
  fetchUsage,
  type LiveOverview,
  type NowPlayingEntry,
  type ScanRequestResult,
} from "@/lib/api";

/**
 * How the Overview reads the Worker (#82, "Polling and refetch"). Only the
 * live route is polled, at the scan's pace; the library is read on page load
 * and again when a pass ends; usage every five minutes, as often as the
 * server refreshes it. Each interval is TanStack Query's `refetchInterval`,
 * whose `refetchIntervalInBackground: false` (the default, spelled out
 * below) skips every tick while the tab is hidden: `focusManager` follows
 * `document.visibilityState`, so a dashboard left in a background tab costs
 * nothing, and `refetchOnWindowFocus` refreshes it on return.
 */

/** How often the live route is read while a pass is in flight. */
export const LIVE_INTERVAL_SCANNING_MS = 10_000;
/** How often it is read otherwise: now playing moves on locally in between. */
export const LIVE_INTERVAL_IDLE_MS = 30_000;
/** The library changes only with a pass, so a read stays fresh this long. */
export const LIBRARY_STALE_MS = 5 * 60_000;
/** The server caches usage for five minutes, so nothing reads it more often. */
export const USAGE_INTERVAL_MS = 5 * 60_000;

/**
 * A read of the live route, with the moment it arrived on this browser's
 * clock: the instant its `serverTime` names, from which the positions of now
 * playing are moved on (`estimatePositionMs`). It travels with the data, so
 * a scan request that replaces only `scan` keeps the anchor its positions
 * were read at.
 */
export interface LiveRead extends LiveOverview {
  receivedAt: number;
}

/** The live route's interval: 10 s while `scan.running`, 30 s otherwise. */
export function liveRefetchInterval(live: LiveOverview | undefined): number {
  return live?.scan.running ? LIVE_INTERVAL_SCANNING_MS : LIVE_INTERVAL_IDLE_MS;
}

export const libraryQuery = queryOptions({
  queryKey: ["overview", "library"],
  queryFn: fetchLibraryOverview,
  staleTime: LIBRARY_STALE_MS,
});

export const liveQuery = queryOptions({
  queryKey: ["overview", "live"],
  queryFn: async (): Promise<LiveRead> => {
    const live = await fetchLiveOverview();
    return { ...live, receivedAt: Date.now() };
  },
  staleTime: 0,
  refetchInterval: (query) => liveRefetchInterval(query.state.data),
  refetchIntervalInBackground: false,
});

export const usageQuery = queryOptions({
  queryKey: ["usage"],
  queryFn: fetchUsage,
  staleTime: USAGE_INTERVAL_MS,
  refetchInterval: USAGE_INTERVAL_MS,
  refetchIntervalInBackground: false,
  // The server caches a failure for one to five minutes, so a retry would
  // spend Worker requests on the same answer.
  retry: false,
});

/**
 * Whether a pass ended between two reads of the live route: `scan.running`
 * went from `true` to `false`. A first read, with nothing before it, ends
 * nothing.
 */
export function passEnded(
  previous: LiveOverview | undefined,
  next: LiveOverview | undefined,
): boolean {
  return previous?.scan.running === true && next?.scan.running === false;
}

/**
 * Follows the live route from one read to the next: when a pass has ended,
 * the library it changed is read again (at once while the Overview shows
 * it). Answers whether it was.
 */
export function followLive(
  queryClient: QueryClient,
  previous: LiveOverview | undefined,
  next: LiveOverview | undefined,
): boolean {
  if (!passEnded(previous, next)) {
    return false;
  }
  void queryClient.invalidateQueries({ queryKey: libraryQuery.queryKey });
  return true;
}

/**
 * What a press of **Scan now** leaves behind. The answer's `scan`, read after
 * the poke, stands for the live route's next read: it says `running`, which
 * puts the poll at its 10 s pace at once. A separate read of the live route
 * now could not do better, and would do worse: the driver's first alarm,
 * which writes the pass's progress, has not run yet, so it would read as no
 * scan at all for a whole idle interval. The library is read again too, as
 * #82 asks after a scan request.
 */
export function afterScanRequest(queryClient: QueryClient, result: ScanRequestResult): void {
  queryClient.setQueryData(liveQuery.queryKey, (live) =>
    live === undefined ? live : { ...live, scan: result.scan },
  );
  void queryClient.invalidateQueries({ queryKey: libraryQuery.queryKey });
}

/**
 * Where a listener is by `now`, between two polls: the position the server
 * estimated at its `serverTime`, moved on at the session's rate for the time
 * since, and never past the end of the track. It is the server's own
 * `estimatedPositionMs` (nowplaying/session.ts): only a playing session
 * moves; a starting one is still buffering and a paused one is where it
 * stopped.
 *
 * The time since `serverTime` is measured on this browser's clock alone,
 * from `receivedAt`, the same instant as this clock saw it (to within the
 * response's transit), so a clock that is minutes off moves the position by
 * the seconds that pass, not by the clocks' difference.
 */
export function estimatePositionMs(
  entry: Pick<NowPlayingEntry, "state" | "positionMs" | "playbackRate"> & {
    track: Pick<NowPlayingEntry["track"], "durationSec">;
  },
  receivedAt: number,
  now: number,
): number {
  if (entry.state !== "playing") {
    return entry.positionMs;
  }
  const elapsed = Math.max(now - receivedAt, 0);
  const position = entry.positionMs + Math.trunc(elapsed * entry.playbackRate);
  return Math.min(position, Math.trunc(entry.track.durationSec * 1_000));
}
