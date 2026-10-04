import { type QueryClient, queryOptions } from "@tanstack/react-query";

import {
  fetchLibraryOverview,
  fetchLiveOverview,
  fetchUsage,
  type Library,
  type LiveOverview,
  type NowPlayingEntry,
  type ScanPause,
  type ScanRequestResult,
  type ScanSchedule,
  type ScanStatus,
  type ServerClock,
} from "@/lib/api";
import { describeConnectionFailure } from "@/lib/errors";

/**
 * How the Overview reads the Worker (#82, "Polling and refetch"). Only the
 * live route is polled, at the scan's pace; the library is read on page load
 * and again when a pass ends; usage every five minutes, as often as the
 * server refreshes it. Each interval is TanStack Query's `refetchInterval`,
 * whose `refetchIntervalInBackground: false` (the default, spelled out
 * below) skips every tick while the tab is hidden: `focusManager` follows
 * `document.visibilityState`, so a dashboard left in a background tab costs
 * nothing, and `refetchOnWindowFocus` refreshes the live route and usage on
 * return. The library is read on return only if a pass ended meanwhile.
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
export interface LiveRead extends LiveOverview, ServerClock {}

/** The live route's interval: 10 s while `scan.running`, 30 s otherwise. */
export function liveRefetchInterval(live: LiveOverview | undefined): number {
  return live?.scan.running ? LIVE_INTERVAL_SCANNING_MS : LIVE_INTERVAL_IDLE_MS;
}

/** Every read of the Overview's library, whichever library it is narrowed to. */
export const LIBRARY_KEY = ["overview", "library"] as const;

/**
 * The libraries list's key (lib/libraries.ts, `librariesQuery`), here so the
 * live route can mark it stale when a pass ends without an import cycle.
 */
export const LIBRARIES_KEY = ["libraries"] as const;

/**
 * The Overview's library: every active library's (`null`), or one's, each
 * its own entry in the cache (#84, "Console"), so switching back shows the
 * last read at once.
 */
export function libraryQuery(library: number | null = null) {
  return queryOptions({
    queryKey: [...LIBRARY_KEY, library ?? "all"],
    queryFn: () => fetchLibraryOverview(library),
    staleTime: LIBRARY_STALE_MS,
    // Only a pass changes the library, and the live route's read on return
    // tells whether one ended meanwhile (`passEnded`): a return with nothing
    // new reads nothing.
    refetchOnWindowFocus: false,
  });
}

/**
 * The library id a search parameter names: a positive integer, given as a
 * number or as its digits (the router parses `?library=2` as JSON first),
 * or `undefined` for anything else.
 */
export function libraryParam(raw: unknown): number | undefined {
  const id =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^[1-9]\d*$/.test(raw)
        ? Number(raw)
        : Number.NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * The `?library=` search parameter of the Overview (#84): one library's id,
 * or absent for every library. Anything that names no library is dropped.
 */
export function validateOverviewSearch(search: Record<string, unknown>): { library?: number } {
  const library = libraryParam(search.library);
  return library === undefined ? {} : { library };
}

export const liveQuery = queryOptions({
  queryKey: ["overview", "live"],
  // Each read is compared with the one before it, still in the cache, so
  // the library is read again once a pass ends, whichever read sees it end.
  queryFn: async ({ client, queryKey }): Promise<LiveRead> => {
    const next = { ...(await fetchLiveOverview()), receivedAt: Date.now() };
    followLive(client, client.getQueryData<LiveRead>(queryKey), next);
    return next;
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
 * Whether a pass ended between two reads of the live route, so the library
 * it changed is worth reading again. The later read finds no pass running,
 * and either the one before found one (`scan.running` went from `true` to
 * `false`) or the last completed pass is another one (`scan.last` finished
 * at another time): a pass the cron ran from start to end while the tab
 * was hidden, which no read saw running. A first read, with nothing before
 * it, ends nothing.
 *
 * A pass writes its summary when its scan phase ends, before its playlists
 * import; waiting for it to stop running reads the library once a pass,
 * with its playlists, rather than once for each phase.
 */
export function passEnded(
  previous: LiveOverview | undefined,
  next: LiveOverview | undefined,
): boolean {
  if (previous === undefined || next === undefined || next.scan.running) {
    return false;
  }
  return (
    previous.scan.running ||
    (previous.scan.last?.finishedAt ?? null) !== (next.scan.last?.finishedAt ?? null)
  );
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
  void queryClient.invalidateQueries({ queryKey: LIBRARY_KEY });
  // The libraries' last scans, which say which library a pass skipped.
  void queryClient.invalidateQueries({ queryKey: LIBRARIES_KEY });
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
  void queryClient.invalidateQueries({ queryKey: LIBRARY_KEY });
}

/**
 * Which library a running pass is in (#84, "Console"): "Scanning Archive (2
 * of 3).", or `null` with one library, where the sentence would add nothing,
 * and while the pass is in none (between two, or importing playlists).
 */
export function describeScanLibrary(scan: Pick<ScanStatus, "library">): string | null {
  const position = scan.library;
  if (!position || position.of < 2) {
    return null;
  }
  return `Scanning ${position.name} (${position.index} of ${position.of}).`;
}

/**
 * The scan's pause at the daily D1 write budget (#84, "Daily D1 write
 * budget"), with when it resumes, in this browser's zone: "Paused until
 * tomorrow at 2:00 AM: daily write budget.", or "Paused until 5:00 PM: daily
 * write budget." when 00:00 UTC is still today here (the time in the
 * browser's locale; a later day by its date). `null` while not
 * paused.
 */
export function describePause(
  paused: ScanPause | null | undefined,
  now: number,
  locale?: string,
  timeZone?: string,
): string | null {
  if (!paused) {
    return null;
  }
  const until = new Date(paused.until);
  if (Number.isNaN(until.getTime())) {
    return "Paused until tomorrow: daily write budget.";
  }
  const time = new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone }).format(until);
  const days = dayNumber(until, timeZone) - dayNumber(new Date(now), timeZone);
  const when =
    days <= 0 ? time : days === 1 ? `tomorrow at ${time}` : formatDayTime(until, locale, timeZone);
  return `Paused until ${when}: daily write budget.`;
}

/** A day's number in `timeZone`, for counting the days between two instants there. */
function dayNumber(at: Date, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone,
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000;
}

function formatDayTime(at: Date, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(at);
}

/**
 * The libraries the last pass skipped, each in a sentence (#84, "Skipping
 * a library"): "Archive was skipped: the key was refused.". A library being
 * removed is left out: nothing about it matters any more.
 */
export function describeSkipped(
  libraries: readonly Pick<Library, "name" | "state" | "lastScanError">[],
): string[] {
  return libraries
    .filter((library) => library.state === "active" && library.lastScanError !== null)
    .map((library) => {
      const { title } = describeConnectionFailure(library.lastScanError);
      return `${library.name} was skipped: ${title.charAt(0).toLowerCase()}${title.slice(1)}.`;
    });
}

/**
 * The sentence the Library scan section says about a pass the server will
 * run for recent file changes (#83, "Overview"), or `null` when none is
 * pending. A pass scheduled at a time already past is starting: its alarm is
 * due, or its first step has not reported yet.
 *
 * `scheduledAt` is on the server's clock, so the time left is counted from
 * the live read's `serverTime`, moved on by the time this browser has seen
 * pass since it arrived (`receivedAt` to `now`), as now playing's positions
 * are (`estimatePositionMs`): a browser clock minutes off changes nothing.
 */
export function describeSchedule(scan: ScanStatus, clock: ServerClock, now: number): string | null {
  const state = scheduleState(scan.scheduled, clock, now);
  switch (state?.state) {
    case undefined:
      return null;
    case "after-current-pass":
      return "A scan is running. Another follows it for recent file changes.";
    case "covered":
      return "A scan is running.";
    case "starting":
      return "A scan is starting.";
    case "scheduled":
      return `A scan is scheduled in ${aboutMinutes(state.minutes)}.`;
  }
}

/**
 * Where a `ScanSchedule` stands by `now`, which the Overview's Library scan
 * and the Files page's scan line each put in their own words:
 *
 * - `scheduled`: a pass starts in about `minutes` (at least 1);
 * - `starting`: its time has come, and its alarm is due or its first step
 *   has not reported yet;
 * - `after-current-pass`: a pass is running, and one more follows it;
 * - `covered`: a pass is running that began after the change, and covers it.
 *
 * The time left is counted on the server's clock: `clock.serverTime`, moved
 * on by the time this browser has seen pass since the answer arrived
 * (`receivedAt` to `now`).
 */
export type ScheduleState =
  | { state: "scheduled"; minutes: number }
  | { state: "starting" }
  | { state: "after-current-pass" }
  | { state: "covered" };

export function scheduleState(
  scheduled: ScanSchedule | null,
  clock: ServerClock,
  now: number,
): ScheduleState | null {
  if (!scheduled) {
    return null;
  }
  if (scheduled.afterCurrentPass) {
    return { state: "after-current-pass" };
  }
  if (scheduled.scheduledAt === null) {
    return { state: "covered" };
  }
  const serverNow = Date.parse(clock.serverTime) + Math.max(now - clock.receivedAt, 0);
  const remaining = Date.parse(scheduled.scheduledAt) - serverNow;
  if (!(remaining > 0)) {
    return { state: "starting" };
  }
  return { state: "scheduled", minutes: Math.max(Math.round(remaining / 60_000), 1) };
}

/** `about a minute`, `about 2 minutes`. */
export function aboutMinutes(minutes: number): string {
  return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
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
