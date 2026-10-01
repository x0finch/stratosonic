import { queryOptions } from "@tanstack/react-query";

/**
 * The console's calls to the Worker's JSON API under `/api` (#81, #89, #90).
 *
 * Every call is a plain `fetch` on the console's own origin: the session lives
 * in HttpOnly cookies the browser sends by itself, and a POST carries JSON,
 * which is what the API and Better Auth's origin check expect.
 */

/**
 * Who is signed in, as `GET /api/me` answers: a console user, the console's
 * own kind of account (#99), with their role and the permissions it grants.
 */
export interface Me {
  id: string;
  username: string;
  role: string;
  permissions: string[];
}

/** What `GET /api/setup` says: whether the setup token can set the server up now. */
export type SetupState = "needs-setup" | "closed";

/**
 * A refused or failed call. `code` is the API's `error`, Better Auth's `code`
 * brought to the same vocabulary, `rate_limited` for a 429, `network` when
 * the Worker could not be reached, or `http_<status>` when the body names
 * nothing.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** The seconds a rate-limited caller has to wait, when the server says. */
  readonly retryAfter: number | undefined;
  /**
   * The API's `reason`, when it says more than its code: why the usage
   * panel's analytics are unavailable (`analytics_unavailable`, #82).
   */
  readonly reason: string | undefined;

  constructor(status: number, code: string, message: string, retryAfter?: number, reason?: string) {
    super(message || code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.reason = reason;
  }
}

/**
 * Better Auth answers with its own upper-case codes. The two the console meets
 * on sign-in are renamed to the API's words; any other is lower-cased.
 */
const BETTER_AUTH_CODES: Record<string, string> = {
  INVALID_USERNAME_OR_PASSWORD: "invalid_credentials",
  INVALID_ORIGIN: "forbidden_origin",
  MISSING_OR_NULL_ORIGIN: "forbidden_origin",
};

function errorCode(status: number, body: unknown): string {
  if (status === 429) {
    return "rate_limited";
  }
  if (typeof body === "object" && body !== null) {
    if ("error" in body && typeof body.error === "string") {
      return body.error;
    }
    if ("code" in body && typeof body.code === "string") {
      return BETTER_AUTH_CODES[body.code] ?? body.code.toLowerCase();
    }
  }
  return `http_${status}`;
}

function errorReason(body: unknown): string | undefined {
  if (typeof body === "object" && body !== null && "reason" in body) {
    return typeof body.reason === "string" ? body.reason : undefined;
  }
  return undefined;
}

function errorMessage(body: unknown): string {
  if (typeof body === "object" && body !== null && "message" in body) {
    return typeof body.message === "string" ? body.message : "";
  }
  return "";
}

/** Better Auth's rate limiter names the wait in `X-Retry-After`, in seconds. */
function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("X-Retry-After") ?? response.headers.get("Retry-After");
  const seconds = value === null ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Every write carries a JSON body, `{}` when it has nothing to say (a
 * `DELETE`, say): the API's same-origin check asks for a JSON `Content-Type`
 * on every write (#82).
 */
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function call<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const write = method !== "GET";
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: write
        ? { Accept: "application/json", "Content-Type": "application/json" }
        : { Accept: "application/json" },
      body: write ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch (error) {
    throw new ApiError(0, "network", error instanceof Error ? error.message : "");
  }

  const payload = await readBody(response);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      errorCode(response.status, payload),
      errorMessage(payload),
      retryAfter(response),
      errorReason(payload),
    );
  }
  return payload as T;
}

/**
 * Whether a failed read is worth another try, as TanStack Query's `retry`
 * asks: up to three times, as its default, but never a refusal (a 4xx),
 * which would only be refused again. A session that has ended then signs
 * the console out at once (main.tsx), not after the retries' backoff.
 */
export function retryUnlessRefused(failureCount: number, error: unknown): boolean {
  const refused = error instanceof ApiError && error.status >= 400 && error.status < 500;
  return !refused && failureCount < 3;
}

/** The signed-in console user, or `null` without a session. */
export async function fetchMe(): Promise<Me | null> {
  try {
    return await call<Me>("GET", "/api/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

export async function fetchSetupState(): Promise<SetupState> {
  const { state } = await call<{ state: SetupState }>("GET", "/api/setup");
  return state;
}

export interface Credentials {
  username: string;
  password: string;
}

/** Signs in through Better Auth's username plugin; the session is a cookie. */
export async function signIn({ username, password }: Credentials): Promise<void> {
  await call("POST", "/api/auth/sign-in/username", { username, password });
}

export async function signOut(): Promise<void> {
  await call("POST", "/api/auth/sign-out");
}

export interface SetupRequest extends Credentials {
  token: string;
}

/** Creates the owner account with the setup token, while there is no console user. */
export async function setUp(request: SetupRequest): Promise<void> {
  await call("POST", "/api/setup", request);
}

/** Changes the signed-in console user's password, signing out its other sessions. */
export async function changePassword(request: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  await call("POST", "/api/account/password", request);
}

/**
 * A Subsonic user as `GET /api/subsonic-users` lists it (#82): never a
 * password, in plaintext or ciphertext. `isAdmin` is the **Subsonic admin**
 * role, which has nothing to do with console roles.
 */
export interface SubsonicUser {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
  updatedAt: string;
  lastAccessAt: string | null;
  /** How many playlists they own, which a delete would take with them. */
  playlistCount: number;
}

export async function fetchSubsonicUsers(): Promise<SubsonicUser[]> {
  const { users } = await call<{ users: SubsonicUser[] }>("GET", "/api/subsonic-users");
  return users;
}

export async function createSubsonicUser(request: {
  username: string;
  password: string;
  isAdmin: boolean;
}): Promise<SubsonicUser> {
  const { user } = await call<{ user: SubsonicUser }>("POST", "/api/subsonic-users", request);
  return user;
}

/** Renames a Subsonic user, turns **Subsonic admin** on or off, or both. */
export async function updateSubsonicUser(
  id: string,
  changes: { username?: string; isAdmin?: boolean },
): Promise<SubsonicUser> {
  const { user } = await call<{ user: SubsonicUser }>(
    "PATCH",
    `/api/subsonic-users/${encodeURIComponent(id)}`,
    changes,
  );
  return user;
}

/** Sets a Subsonic user's password; no current password is needed (#82). */
export async function setSubsonicPassword(id: string, password: string): Promise<void> {
  await call("PUT", `/api/subsonic-users/${encodeURIComponent(id)}/password`, { password });
}

export async function deleteSubsonicUser(id: string): Promise<void> {
  await call("DELETE", `/api/subsonic-users/${encodeURIComponent(id)}`);
}

/**
 * The Subsonic users. Never polled: only the console changes them, and each
 * of its writes invalidates this query (#82's polling table).
 */
export const subsonicUsersQuery = queryOptions({
  queryKey: ["subsonic-users"],
  queryFn: fetchSubsonicUsers,
  staleTime: 30 * 1000,
});

/**
 * The signed-in console user. The server vouches for a session from its 5-minute
 * cookie cache (#81), so a fresher copy here would buy nothing.
 */
export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: fetchMe,
  staleTime: 5 * 60 * 1000,
  retry: false,
});

/**
 * What the setup token may do. It changes only when a setup screen spends
 * the token, which drops this query (setup-form.tsx), or when the Worker's
 * secret is replaced, so a refocused window need not ask again at once.
 */
export const setupStateQuery = queryOptions({
  queryKey: ["setup-state"],
  queryFn: fetchSetupState,
  staleTime: 30 * 1000,
  retry: false,
});

/** The library's totals, as `GET /api/overview/library` counts them (#82). */
export interface LibraryCounts {
  artists: number;
  albums: number;
  tracks: number;
  genres: number;
  durationSec: number;
  sizeBytes: number;
}

/** One genre, as `getGenres` lists it, in Navidrome's order. */
export interface GenreCount {
  name: string;
  songCount: number;
  albumCount: number;
}

/** One of the albums added last, newest first. */
export interface RecentAlbum {
  id: string;
  name: string;
  artist: string;
  year: number | null;
  songCount: number;
  createdAt: string;
}

/** A playlist, with the Subsonic user it belongs to (`null` for none). */
export interface PlaylistSummary {
  id: string;
  name: string;
  owner: string | null;
  public: boolean;
  songCount: number;
  durationSec: number;
  changedAt: string;
}

/** `GET /api/overview/library`: read on page load and when a pass ends, never polled. */
export interface LibraryOverview {
  counts: LibraryCounts;
  genres: GenreCount[];
  recentAlbums: RecentAlbum[];
  playlists: PlaylistSummary[];
}

/** What a completed pass did, as its `LastScanSummary` holds it. */
export interface LastScanCounts {
  examined: number;
  indexed: number;
  added: number;
  updated: number;
  unchanged: number;
  broken: number;
  deferred: number;
  removed: number;
  albumsRemoved: number;
  artistsRemoved: number;
  coversWritten: number;
}

/**
 * The scan, as `getScanStatus` sees it: whether a pass is in flight, how far
 * its scan phase has got, and the last completed pass.
 */
export interface ScanStatus {
  running: boolean;
  phase: "scan" | "playlists" | null;
  /** Only while `phase` is `"scan"`. `tracks` is `indexed + unchanged`. */
  progress: {
    startedAt: string;
    tracks: number;
    examined: number;
    added: number;
    updated: number;
    removed: number;
  } | null;
  /** The last pass's track count, the best denominator there is; `null` before any pass. */
  estimatedTotal: number | null;
  last: {
    startedAt: string;
    finishedAt: string;
    steps: number;
    counts: LastScanCounts;
  } | null;
}

/** Someone listening, with the position the server estimated at `serverTime`. */
export interface NowPlayingEntry {
  username: string;
  playerName: string;
  state: "playing" | "paused" | "starting";
  positionMs: number;
  playbackRate: number;
  startedAt: string;
  track: {
    id: string;
    title: string;
    artist: string;
    /** `""` while the track's album row is not written yet. */
    album: string;
    albumId: string;
    durationSec: number;
  };
}

/** `GET /api/overview/live`, the one polled overview route. */
export interface LiveOverview {
  scan: ScanStatus;
  /** `null` for a role without `activity:read`. */
  nowPlaying: NowPlayingEntry[] | null;
  /** When the server estimated the positions, to move them on from. */
  serverTime: string;
}

/** What a press of **Scan now** did: started a pass, or found one in flight. */
export interface ScanRequestResult {
  outcome: "started" | "running";
  scan: ScanStatus;
}

/**
 * A figure of the usage panel: `null` when Cloudflare's answer did not carry
 * it, so a field renamed upstream blanks one figure rather than the panel.
 */
export type UsageFigure = number | null;

/**
 * `GET /api/usage` with an analytics token: today's usage of the whole
 * account (UTC), R2's operations month to date, and R2's storage as each
 * bucket's peak of the last 24 hours, summed.
 */
export interface ConfiguredUsage {
  configured: true;
  fetchedAt: string;
  day: string;
  monthStart: string;
  workers: { requests: UsageFigure; errors: UsageFigure; limit: { requests: number } };
  d1: {
    rowsRead: UsageFigure;
    rowsWritten: UsageFigure;
    limit: { rowsRead: number; rowsWritten: number };
  };
  durableObjects: {
    requests: UsageFigure;
    cpuTimeMs: UsageFigure;
    durationGbSeconds: UsageFigure;
    limit: { requests: number; durationGbSeconds: number };
  };
  r2: {
    classA: UsageFigure;
    classB: UsageFigure;
    storageBytes: UsageFigure;
    objectCount: UsageFigure;
    limit: { classA: number; classB: number; storageBytes: number };
  };
}

/** `GET /api/usage`: the account's free-tier usage, or no token to read it with. */
export type Usage = { configured: false } | ConfiguredUsage;

export function fetchLibraryOverview(): Promise<LibraryOverview> {
  return call<LibraryOverview>("GET", "/api/overview/library");
}

export function fetchLiveOverview(): Promise<LiveOverview> {
  return call<LiveOverview>("GET", "/api/overview/live");
}

/** Pokes the scan driver, as Subsonic's `startScan` does. The body is `{}`. */
export function requestScan(): Promise<ScanRequestResult> {
  return call<ScanRequestResult>("POST", "/api/library/scan");
}

export function fetchUsage(): Promise<Usage> {
  return call<Usage>("GET", "/api/usage");
}
