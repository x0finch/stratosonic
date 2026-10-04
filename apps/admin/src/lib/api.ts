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
  return (await exchange<T>(method, path, body)).payload;
}

/**
 * A call, with the instant the server answered as its `Date` header names it
 * (to the second), or `null` when there is none: the clock a write's
 * `ScanSchedule` is counted down on (`withClock`).
 */
async function exchange<T>(
  method: Method,
  path: string,
  body?: unknown,
  options: { keepalive?: boolean } = {},
): Promise<{ payload: T; date: string | null }> {
  const write = method !== "GET";
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      ...(options.keepalive ? { keepalive: true } : {}),
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
  return { payload: payload as T, date: response.headers.get("Date") };
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
  /** What the server will do about recent file changes; `null` when none is pending. */
  scheduled: ScanSchedule | null;
}

/**
 * A pass the server will run for recent file changes (#83): one starting at
 * about `scheduledAt`, once the library has been quiet for two minutes, one
 * more after the pass in flight, or none beyond the pass in flight, which
 * covers the change.
 */
export type ScanSchedule =
  | { scheduledAt: string; afterCurrentPass: false }
  | { scheduledAt: null; afterCurrentPass: true }
  /** A pass is running that began after the change, and covers it. */
  | { scheduledAt: null; afterCurrentPass: false };

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

/**
 * The server's clock at an answer, with the moment the answer arrived on
 * this browser's clock: what a `ScanSchedule` is counted down from, as the
 * live route's `serverTime` and `receivedAt` are (#83 amendments:
 * `serverTime + (now − receivedAt)`), so a browser clock minutes off
 * changes nothing.
 */
export interface ServerClock {
  serverTime: string;
  receivedAt: number;
}

/**
 * A write's answer with its clock: the server's `Date` header, or this
 * browser's clock when the answer has none that parses.
 */
function withClock<T>({ payload, date }: { payload: T; date: string | null }): T & {
  clock: ServerClock;
} {
  const receivedAt = Date.now();
  const at = date === null ? Number.NaN : Date.parse(date);
  const serverTime = new Date(Number.isFinite(at) ? at : receivedAt).toISOString();
  return { ...payload, clock: { serverTime, receivedAt } };
}

/** The kinds of file the server reads, and `other` for the rest (#83). */
export type FileKind = "audio" | "lyrics" | "playlist" | "image" | "other";

/** The kinds of file an upload may be: the ones the server reads. */
export type UploadKind = Exclude<FileKind, "other">;

/**
 * `GET /api/files/config` (#83, "API: configuration"), read once a session.
 * `uploads` says whether the Worker can presign uploads; `missing` names the
 * values it lacks, never their contents. `allowed` is the allow-list the
 * console mirrors to refuse a file before any request (lib/uploads.ts), and
 * `limits.signBatch` is the most files one sign request takes (#83
 * amendments: 10), which the console reads rather than assumes.
 */
export interface FilesConfig {
  /** `R2_BUCKET_NAME`, or null when it is unset. */
  bucket: string | null;
  uploads: { configured: true } | { configured: false; missing: string[] };
  allowed: Record<UploadKind, { suffixes: string[]; maxBytes: number }>;
  limits: {
    maxKeyBytes: number;
    maxSegmentBytes: number;
    signBatch: number;
    deleteBatch: number;
  };
  rescanQuietSeconds: number;
  /** False where `FILE_WRITES` is `"off"` (the preview): the page is read-only. */
  writes: { enabled: boolean };
}

/** A folder of the folder browsed: a common prefix, ending in `/`. */
export interface FolderEntry {
  name: string;
  prefix: string;
}

/** A file of the folder browsed, with its key exactly as R2 lists it. */
export interface FileEntry {
  name: string;
  key: string;
  size: number;
  /** R2's `uploaded`, the only timestamp an object has. */
  uploadedAt: string;
  kind: FileKind;
}

/** One page of one folder, as `GET /api/files` answers it: folders, then files, in R2's order. */
export interface FolderListing {
  prefix: string;
  folders: FolderEntry[];
  files: FileEntry[];
  /** R2's cursor for the next page, or `null` on the last. */
  cursor: string | null;
}

/** What `POST /api/files/delete` did. `scan` is `null` when the driver could not be told. */
export interface DeleteFilesResult {
  deleted: number;
  scan: ScanSchedule | null;
  clock: ServerClock;
}

/**
 * One round of `POST /api/files/delete-folder`, called again until `done`.
 * A round that found nothing left to delete has no `scan` at all (#83
 * amendments): the round before it still speaks for the change.
 */
export interface DeleteFolderResult {
  deleted: number;
  done: boolean;
  scan?: ScanSchedule | null;
  clock: ServerClock;
}

export function fetchFilesConfig(): Promise<FilesConfig> {
  return call<FilesConfig>("GET", "/api/files/config");
}

/** One page of the folder `prefix` (`""` for the root), from R2's `cursor` when given. */
export function fetchFiles(prefix: string, cursor?: string | null): Promise<FolderListing> {
  const query = new URLSearchParams({ prefix });
  if (cursor) {
    query.set("cursor", cursor);
  }
  return call<FolderListing>("GET", `/api/files?${query}`);
}

/** Deletes 1–250 keys, exactly as browse listed them. Permanent: there is no undo. */
export async function deleteFiles(keys: readonly string[]): Promise<DeleteFilesResult> {
  return withClock(
    await exchange<Omit<DeleteFilesResult, "clock">>("POST", "/api/files/delete", { keys }),
  );
}

/**
 * One round of a folder delete: up to 2,000 keys under `prefix`, at any
 * depth. Permanent: there is no undo.
 */
export async function deleteFolderRound(prefix: string): Promise<DeleteFolderResult> {
  return withClock(
    await exchange<Omit<DeleteFolderResult, "clock">>("POST", "/api/files/delete-folder", {
      prefix,
    }),
  );
}

/** One file to sign: its key in the folder `prefix`, its exact size, and whether it replaces. */
export interface UploadToSign {
  key: string;
  size: number;
  overwrite: boolean;
}

/** A presigned `PUT`: send exactly `headers` with the file's bytes, before `expiresAt`. */
export interface PresignedUpload {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  /** When the URL stops working, on the server's clock. */
  expiresAt: string;
}

/**
 * Why the server would not sign one file (apps/server README, "File
 * uploads"). `replace_unavailable`: a Replace whose stored spelling it could
 * not find for certain; replace that file with rclone.
 */
export type UploadRefusalCode =
  | "invalid_path"
  | "path_too_long"
  | "reserved_path"
  | "type_not_allowed"
  | "too_large"
  | "empty_file"
  | "replace_unavailable";

/**
 * One file's answer, in the order asked. `key` is the key to write: the one
 * asked for with the part after `prefix` in NFC, or on Replace the key
 * exactly as R2 stores it.
 */
export type SignedResult =
  | ({ key: string } & PresignedUpload)
  | { key: string; error: "exists"; existing: { size: number; uploadedAt: string } }
  | { key: string; error: UploadRefusalCode };

/** `POST /api/files/uploads`, with the server's clock the expiries are counted on. */
export interface SignUploadsResult {
  uploads: SignedResult[];
  clock: ServerClock;
}

/**
 * Presigns 1–`limits.signBatch` uploads into the folder `prefix`, exactly as
 * browse listed it: the server keeps it as it is and normalises only the
 * part of each key after it, so a folder stored in NFD gets no NFC twin.
 */
export async function signUploads(
  prefix: string,
  files: readonly UploadToSign[],
): Promise<SignUploadsResult> {
  return withClock(
    await exchange<Omit<SignUploadsResult, "clock">>("POST", "/api/files/uploads", {
      prefix,
      files,
    }),
  );
}

/** A picked key that already exists, as `POST /api/files/uploads/check` answers it. */
export interface ExistingUpload {
  /** The key as asked. */
  key: string;
  /** The key exactly as R2 lists it, which may be another Unicode spelling. */
  storedKey: string;
  size: number;
  uploadedAt: string;
}

/**
 * `POST /api/files/uploads/check`: which keys exist, and which the server
 * could not check (their folder was too large to list to its end).
 */
export interface UploadCheckResult {
  existing: ExistingUpload[];
  unchecked: string[];
}

/**
 * Asks which of 1–1,000 keys in the folder `prefix` (as browse listed it)
 * already exist, before any is signed (#141). A key the upload rules refuse
 * is in neither list.
 */
export function checkUploads(prefix: string, keys: readonly string[]): Promise<UploadCheckResult> {
  return call<UploadCheckResult>("POST", "/api/files/uploads/check", { prefix, keys });
}

/** What `POST /api/files/uploads/complete` said the scan will do. */
export interface CompleteUploadsResult {
  scan: ScanSchedule | null;
  clock: ServerClock;
}

/**
 * Reports 1–`limits.signBatch` keys whose `PUT` R2 accepted, so the server
 * schedules its debounced scan. It goes with `keepalive`, so a tab closed
 * right after the last upload still reports it.
 */
export async function completeUploads(keys: readonly string[]): Promise<CompleteUploadsResult> {
  return withClock(
    await exchange<Omit<CompleteUploadsResult, "clock">>(
      "POST",
      "/api/files/uploads/complete",
      { keys },
      { keepalive: true },
    ),
  );
}

/** Why a bucket could not be reached, as the server's storage layer names it (#84). */
export type StorageFailure =
  | "auth"
  | "bucket_not_found"
  | "throttled"
  | "invalid_cursor"
  | "unavailable";

/** What a library holds, from its albums' aggregates. */
export interface LibraryContents {
  artists: number;
  albums: number;
  tracks: number;
  sizeBytes: number;
  durationSec: number;
}

/**
 * A library as `GET /api/libraries` lists it (#84, "Libraries API"), never
 * with a key. Library 1 is the bucket the Worker is bound to (`kind`
 * `r2-binding`), which has no key at all; any other is an R2 bucket reached
 * with an API token, shown by its Access Key ID's last four characters.
 */
export interface Library {
  id: number;
  name: string;
  kind: "r2-binding" | "s3";
  accountId: string | null;
  /** `R2_BUCKET_NAME` for library 1, which may be unset. */
  bucket: string | null;
  /** `…3F9A`, or null for library 1 and for a token that no longer opens. */
  accessKeyIdHint: string | null;
  writable: boolean;
  defaultNewUsers: boolean;
  state: "active" | "removing";
  lastScanStartedAt: string | null;
  lastScanAt: string | null;
  /** Why the last pass skipped it (a `StorageFailure`), or null. */
  lastScanError: string | null;
  counts: LibraryContents;
}

/** `GET /api/libraries`: the libraries in id order, and `CF_ACCOUNT_ID` to prefill a new one's. */
export interface LibraryList {
  libraries: Library[];
  defaultAccountId: string | null;
}

/** What a connect or a change of bucket did to the scan; `null` when the driver could not be told. */
export type LibraryScan = "started" | "running" | null;

/** The fields of a new library: a name, the bucket, and the R2 API token that reaches it. */
export interface NewLibrary {
  name: string;
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  defaultNewUsers: boolean;
}

/** What a PATCH changes: any of these, the two keys together. Library 1 takes the first two only. */
export interface LibraryChanges {
  name?: string;
  defaultNewUsers?: boolean;
  accountId?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/**
 * `POST /api/libraries/:id/test`: whether the stored token lists the bucket,
 * and whether it can write to it; library 1's also says whether uploads are
 * configured.
 */
export type ConnectionTest =
  | { ok: true; writable: boolean; uploads?: boolean }
  | { ok: false; reason: StorageFailure };

/** What a removal takes out of the index, as the server counted it. */
export interface RemovedLibrary {
  tracks: number;
  albums: number;
  playlists: number;
}

export function fetchLibraries(): Promise<LibraryList> {
  return call<LibraryList>("GET", "/api/libraries");
}

/** Connects a bucket. The server tests it first, and stores nothing when the test fails. */
export function connectLibrary(
  request: NewLibrary,
): Promise<{ library: Library; scan: LibraryScan }> {
  return call("POST", "/api/libraries", request);
}

export function updateLibrary(
  id: number,
  changes: LibraryChanges,
): Promise<{ library: Library; scan: LibraryScan }> {
  return call("PATCH", `/api/libraries/${id}`, changes);
}

export function testLibrary(id: number): Promise<ConnectionTest> {
  return call("POST", `/api/libraries/${id}/test`);
}

/** Starts removing a library: it is gone for every reader at once, and the scan deletes its rows. */
export async function removeLibrary(id: number): Promise<RemovedLibrary> {
  const { removed } = await call<{ removed: RemovedLibrary }>("DELETE", `/api/libraries/${id}`);
  return removed;
}
