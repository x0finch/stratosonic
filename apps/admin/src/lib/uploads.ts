import {
  ApiError,
  type CompleteUploadsResult,
  type FilesConfig,
  type FolderEntry,
  type PresignedUpload,
  type ServerClock,
  type SignUploadsResult,
  type UploadKind,
  type UploadRefusalCode,
  type UploadToSign,
} from "@/lib/api";
import { countOf, FORBIDDEN_CHARACTERS, utf8Length, type WriteSchedule } from "@/lib/files";
import { formatBytes, formatCount } from "@/lib/format";

/**
 * The Files page's uploads (#83, "Upload queue", ticket E): which key each
 * picked file takes, the client's mirror of the allow-list, and the queue, a
 * plain state machine that signs, sends and reports each file. The page only
 * draws it (components/files/uploads-section.tsx).
 *
 * ## One file's way
 *
 * 1. **Checked here first.** A file is checked against `GET /api/files/config`
 *    (`checkUpload`, the server's rules for a new key and its kind's size),
 *    so a refused type or size never reaches the server, and its row says
 *    why. The server stays the authority: it checks again when it signs.
 * 2. **Waiting**, in the order picked.
 * 3. **Signing**, just in time: as uploads finish, the next files are signed
 *    with `POST /api/files/uploads`, as many as there are free places, at
 *    most `UPLOADS_AT_ONCE` (3) and never more than `limits.signBatch`, in
 *    one request whose `prefix` is the folder they go into, exactly as
 *    browse listed it (`uploadTarget`).
 * 4. **Uploading**, with `XMLHttpRequest` (`xhrPut`), the only way a browser
 *    reports an upload's progress, sending exactly the headers the server
 *    signed. A URL that would be within 30 s of its expiry is signed again
 *    instead (once), on the server's clock.
 * 5. **Uploaded** on a 2xx. Landed keys are held, and reported in one
 *    `POST /api/files/uploads/complete` (with `keepalive`) once
 *    `limits.signBatch` (10) of them wait, or once `COMPLETE_QUIET_MS`
 *    (2 s) pass with nothing new landing. The scan line shows the `scan` it
 *    answers. The server's debounce waits 2 minutes, so the hold delays no
 *    pass, and it cuts the complete requests, and their D1 and Durable
 *    Object writes, up to tenfold.
 *
 * Or else:
 *
 * - **Already exists**: the server's `exists`, or R2's `412` for a file
 *   that appeared after it looked. **Replace** signs it again with
 *   `overwrite: true`; **Skip** leaves it. Replace is always the owner's
 *   choice, never automatic.
 * - **Failed**: a refusal (`replace_unavailable` says to use rclone), or a
 *   `PUT` that failed twice: a network error or a `403` (an expired URL has
 *   no CORS headers, so it reads as a network error) is signed again and
 *   tried once more first.
 * - **Canceled** by the owner, or **Skipped**.
 *
 * Two uploads to one key never run at once (R2 takes one write per key per
 * second): a file waits while another to the same key is in flight.
 *
 * ## What it costs
 *
 * Per file: its share of one sign request (1–3 files), one `PUT` straight
 * to R2 (no Worker request), and its share of one complete request (up to
 * 10 landed files). Each `PUT` also has its
 * own CORS preflight (`OPTIONS`, to R2, no Worker request): a browser
 * caches a preflight by its full URL, and no two presigned URLs are alike,
 * so the bucket's `maxAgeSeconds` saves none (measured in Chromium). The folder on
 * screen is read again after uploads land, at most once every
 * `REFRESH_EVERY_MS` (5 s) while the queue runs, and once after the last.
 */

/** Uploads in flight at once: a browser opens about six connections a host, so the console's own calls keep room. */
export const UPLOADS_AT_ONCE = 3;

/** A signed URL is not used this close to its expiry: it is signed again. */
export const EXPIRY_MARGIN_MS = 30_000;

/** The folder on screen is read again at most this often while uploads land. */
export const REFRESH_EVERY_MS = 5_000;

/** Landed keys are reported once this long passes with nothing new landing (or once 10 wait). */
export const COMPLETE_QUIET_MS = 2_000;

/* ---------------------------------------------------------------- keys -- */

/** A file the owner picked: a `File`, from the Files… or the Folder… picker. */
export interface PickedFile extends Blob {
  readonly name: string;
  /** Its path under the folder picked, from Folder… (`Album/CD1/01.flac`); empty from Files…. */
  readonly webkitRelativePath?: string;
}

/** The folders a folder's loaded listing shows, or `undefined` when it has not been read. */
export type FolderLookup = (prefix: string) => readonly FolderEntry[] | undefined;

/**
 * The key a picked file takes, and the folder it goes into as browse listed
 * it: the request's `prefix` (#83 amendments).
 *
 * The key is `<current folder><path>`, `path` being the file's
 * `webkitRelativePath` from Folder… or its name from Files…, so the local
 * structure is kept. The part after `prefix` is written in NFC, as the
 * server writes every new key; `prefix` itself is kept exactly as listed,
 * so a folder stored in NFD (named on a Mac, or copied by rclone) gets no
 * NFC twin.
 *
 * `prefix` is the deepest folder of the key that a listing shows: from the
 * folder on screen, each folder of `path` that the loaded listing of its
 * parent shows, under the same name in either spelling, takes the stored
 * spelling, and the walk stops at the first one not listed (a new folder,
 * or one on a page not loaded). A name two listed folders share in one
 * spelling or another is not guessed at: the walk stops there too.
 */
export function uploadTarget(
  current: string,
  path: string,
  lookup: FolderLookup,
): { prefix: string; key: string } {
  const folders = path.split("/");
  const name = folders.pop() ?? "";
  let prefix = current;
  let walked = 0;
  for (const folder of folders) {
    const listed = listedFolder(lookup(prefix), folder);
    if (listed === undefined) {
      break;
    }
    prefix = listed.prefix;
    walked++;
  }
  const rest = [...folders.slice(walked), name].join("/").normalize("NFC");
  return { prefix, key: `${prefix}${rest}` };
}

/** The listed folder named `name`, exactly or else in its one other listed spelling. */
function listedFolder(
  entries: readonly FolderEntry[] | undefined,
  name: string,
): FolderEntry | undefined {
  if (entries === undefined || name === "") {
    return undefined;
  }
  const exact = entries.find((entry) => entry.name === name);
  if (exact !== undefined) {
    return exact;
  }
  const spelled = name.normalize("NFC");
  const same = entries.filter((entry) => entry.name.normalize("NFC") === spelled);
  return same.length === 1 ? same[0] : undefined;
}

/** Why a file is refused before any request: the server's own codes. */
export type ClientRefusal = Exclude<UploadRefusalCode, "replace_unavailable">;

/** The server's prefix for the covers it extracts, which no upload may write under. */
const RESERVED_PREFIX = "_covers/";

/** A lone surrogate, which no UTF-8 key can hold. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A key's suffix, lower-cased and without its dot, as the server's `suffixOf` reads it. */
export function suffixOf(key: string): string {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The kind a suffix belongs to in the allow-list, or null. */
export function kindOfSuffix(suffix: string, allowed: FilesConfig["allowed"]): UploadKind | null {
  const kinds = Object.keys(allowed) as UploadKind[];
  return kinds.find((kind) => allowed[kind].suffixes.includes(suffix)) ?? null;
}

/**
 * The client's mirror of the server's rules for a new upload (apps/server
 * `files/keys.ts`: `checkUploadKey`, then `checkUploadSize`), in the
 * server's order, from the allow-list and the limits
 * `GET /api/files/config` gives. It answers why the file is refused, or
 * null when the server should take it. The server checks again.
 */
export function checkUpload(
  key: string,
  size: number,
  config: Pick<FilesConfig, "allowed" | "limits">,
): ClientRefusal | null {
  const segments = key.split("/");
  if (
    LONE_SURROGATE.test(key) ||
    !segments.every(
      (segment) =>
        segment !== "" && !segment.startsWith(".") && !FORBIDDEN_CHARACTERS.test(segment),
    )
  ) {
    return "invalid_path";
  }
  if (
    utf8Length(key) > config.limits.maxKeyBytes ||
    segments.some((segment) => utf8Length(segment) > config.limits.maxSegmentBytes)
  ) {
    return "path_too_long";
  }
  if (key.startsWith(RESERVED_PREFIX)) {
    return "reserved_path";
  }
  const kind = kindOfSuffix(suffixOf(key), config.allowed);
  if (kind === null) {
    return "type_not_allowed";
  }
  if (size === 0) {
    return "empty_file";
  }
  return size > config.allowed[kind].maxBytes ? "too_large" : null;
}

/** One picked file, ready for the queue: where it goes, and why it is refused, if it is. */
export interface PlannedUpload {
  file: PickedFile;
  prefix: string;
  key: string;
  refusal: ClientRefusal | null;
}

/**
 * The picked files as the queue takes them, each with its key, its folder
 * prefix and the mirror's verdict. A folder pick brings its hidden files
 * along (`.DS_Store`, `._*`, which macOS writes beside every file), which
 * the server would refuse and the scanner skips, as Navidrome does: they
 * are left out here, without a row. A hidden file picked by name is kept,
 * and its row says why it is refused.
 */
export function planUploads(
  files: readonly PickedFile[],
  current: string,
  config: Pick<FilesConfig, "allowed" | "limits">,
  lookup: FolderLookup,
): PlannedUpload[] {
  return inPathOrder(files.flatMap((file) => planOne(file, current, config, lookup)));
}

/** A pick at least this large is planned in slices, with the page drawn between them. */
export const PLAN_SLICE = 100;

/**
 * `planUploads` for a large pick: the files go in slices of `PLAN_SLICE`,
 * and `yieldToPage` lets the browser draw (and the Upload button show that
 * it is preparing) between them. Reading a picked file's name and size is
 * the browser's own work, about half a millisecond a file in Chromium, so a
 * pick of 2,000 files would otherwise hold the page for a second.
 */
export async function planUploadsInSlices(
  files: readonly PickedFile[],
  current: string,
  config: Pick<FilesConfig, "allowed" | "limits">,
  lookup: FolderLookup,
  yieldToPage: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
): Promise<PlannedUpload[]> {
  const planned: PlannedUpload[] = [];
  for (let start = 0; start < files.length; start += PLAN_SLICE) {
    await yieldToPage();
    for (const file of files.slice(start, start + PLAN_SLICE)) {
      planned.push(...planOne(file, current, config, lookup));
    }
  }
  return inPathOrder(planned);
}

/** One picked file's plan, or none for a folder pick's hidden file. */
function planOne(
  file: PickedFile,
  current: string,
  config: Pick<FilesConfig, "allowed" | "limits">,
  lookup: FolderLookup,
): PlannedUpload[] {
  const path = file.webkitRelativePath || file.name;
  if (file.webkitRelativePath && path.split("/").some((segment) => segment.startsWith("."))) {
    return [];
  }
  const { prefix, key } = uploadTarget(current, path, lookup);
  return [{ file, prefix, key, refusal: checkUpload(key, file.size, config) }];
}

function inPathOrder(planned: readonly PlannedUpload[]): PlannedUpload[] {
  return planned
    .map((upload) => ({ upload, order: pathOrder(upload.key) }))
    .sort((a, b) => comparePathOrder(a.order, b.order))
    .map(({ upload }) => upload);
}

/**
 * The order files go in: by path, case ignored, numbers by their value, so
 * an album uploads from its first track (a browser hands a folder's files
 * over in no set order). Each key is split into its runs of digits and of
 * other characters once, before the sort: `Intl.Collator` gives the same
 * order but cost about half a second for a pick of 2,000 files.
 */
function pathOrder(key: string): (string | number)[] {
  return (key.toLowerCase().match(/\d+|\D+/g) ?? []).map((run) =>
    /^\d/.test(run) && run.length <= 15 ? Number(run) : run,
  );
}

function comparePathOrder(
  a: readonly (string | number)[],
  b: readonly (string | number)[],
): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const left = a[index] as string | number;
    const right = b[index] as string | number;
    if (left === right) {
      continue;
    }
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    return String(left) < String(right) ? -1 : 1;
  }
  return a.length - b.length;
}

/* --------------------------------------------------------------- queue -- */

export type UploadState =
  | "waiting"
  | "signing"
  | "uploading"
  | "uploaded"
  | "exists"
  | "failed"
  | "skipped"
  | "canceled";

/**
 * Why an upload failed: a refusal (the mirror's or the server's), a `PUT`
 * that failed twice (`status` 0 for a network error), or a sign request
 * that failed as a whole.
 */
export type UploadFailure =
  | { code: UploadRefusalCode }
  | { code: "put_failed"; status: number }
  | { code: "sign_failed"; error: unknown };

/** One row of the Uploads section. */
export interface UploadView {
  id: number;
  /** The key: as asked for, then as the server signed it. */
  key: string;
  size: number;
  /** Bytes sent so far. */
  loaded: number;
  state: UploadState;
  failure?: UploadFailure;
  /** What the server said is already at the key, when it said. */
  existing?: { size: number; uploadedAt: string };
}

/** What the queue holds, as the page draws it. */
export interface QueueSnapshot {
  items: readonly UploadView[];
  /** What the last completion said the scan will do, with its clock. */
  schedule: WriteSchedule | undefined;
  /** Whether a file is waiting, being signed or being sent: closing the tab would lose it. */
  busy: boolean;
}

/** What a run of the queue did, from its first file to the last one settled. */
export interface RunSummary {
  uploaded: number;
  /** Failed, or waiting for Replace or Skip. */
  notUploaded: number;
  /** Of `notUploaded`, the files that already exist. */
  conflicts: number;
  /** Whether a completion answered `scan: null`, or failed: the cron's next pass indexes the files. */
  scanUnknown: boolean;
}

/** The calls the queue makes: lib/api.ts's and `xhrPut`, or a test's. */
export interface UploadCalls {
  sign: (prefix: string, files: readonly UploadToSign[]) => Promise<SignUploadsResult>;
  complete: (keys: readonly string[]) => Promise<CompleteUploadsResult>;
  /** Sends the file, and answers the HTTP status, or 0 for a network error or an abort. */
  put: (
    upload: PresignedUpload,
    body: Blob,
    onProgress: (loaded: number) => void,
    signal: AbortSignal,
  ) => Promise<number>;
}

/** What the queue tells its page. */
export interface UploadHooks {
  /**
   * Files landed in the bucket (throttled): read again the folders their
   * keys change, given the keys landed since the last call.
   */
  onRefresh?: (keys: readonly string[]) => void;
  /** Every file of a run has settled. */
  onDrained?: (summary: RunSummary) => void;
  /** A sign or complete request failed: a session that ended signs the console out. */
  onError?: (error: unknown) => void;
  now?: () => number;
}

interface Entry {
  id: number;
  file: PickedFile;
  prefix: string;
  key: string;
  size: number;
  state: UploadState;
  overwrite: boolean;
  loaded: number;
  failure?: UploadFailure;
  existing?: { size: number; uploadedAt: string };
  /** Signed again after a failed `PUT` already. */
  retried: boolean;
  /** Signed again for a URL too close to its expiry already. */
  resigned: boolean;
  /** Counted in a run's summary already. */
  reported: boolean;
  /**
   * A `PUT` of it ended in a network error, so R2 may have taken it with
   * the answer lost: a later Already exists may be this very upload.
   */
  maybeLanded: boolean;
  abort?: AbortController;
  /** Its last row, kept while nothing on it changes. */
  view?: UploadView;
}

/** Listeners hear of changes at most this often: progress alone changes many times a second. */
export const NOTIFY_EVERY_MS = 100;

const ACTIVE: ReadonlySet<UploadState> = new Set(["waiting", "signing", "uploading"]);
const IN_FLIGHT: ReadonlySet<UploadState> = new Set(["signing", "uploading"]);
const FINISHED: ReadonlySet<UploadState> = new Set(["uploaded", "failed", "skipped", "canceled"]);

/** R2 takes NFC-equivalent keys as one object, so two such keys are one key here too. */
function sameKey(key: string): string {
  return key.normalize("NFC");
}

/** A whole sign request refused for a reason every later one would meet too. */
function refusesEveryFile(error: unknown): boolean {
  return error instanceof ApiError && [401, 403, 503].includes(error.status);
}

/**
 * The upload queue. It lives as long as the page (lib's caller keeps one for
 * the session), so uploads carry on while the owner browses other folders.
 */
export class UploadQueue {
  readonly #calls: UploadCalls;
  readonly #hooks: UploadHooks;
  readonly #now: () => number;
  #entries: Entry[] = [];
  #nextId = 1;
  /** Keys that landed and wait to be reported, together. */
  #unreported: string[] = [];
  #completeTimer: ReturnType<typeof setTimeout> | undefined;
  #completing = 0;
  /** Ended (`dispose`): an answer still on its way starts nothing more. */
  #disposed = false;
  #signBatch = UPLOADS_AT_ONCE;
  #schedule: WriteSchedule | undefined;
  #scanUnknown = false;
  #lastRefresh = Number.NEGATIVE_INFINITY;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** The keys landed since the folders were last read again. */
  #landed: string[] = [];
  #listeners = new Set<() => void>();
  #busyListeners = new Set<(busy: boolean) => void>();
  #busy = false;
  #lastNotify = Number.NEGATIVE_INFINITY;
  #notifyQueued = false;
  #dirty = false;
  #snapshot: QueueSnapshot = { items: [], schedule: undefined, busy: false };

  constructor(calls: UploadCalls, hooks: UploadHooks = {}) {
    this.#calls = calls;
    this.#hooks = hooks;
    this.#now = hooks.now ?? (() => Date.now());
  }

  /**
   * For `useSyncExternalStore`: a new object after a change, the same one
   * otherwise. It is built when asked for, and keeps each row's object while
   * nothing on that row changed, so a page of 2,000 rows redraws only the
   * rows that moved.
   */
  readonly getSnapshot = (): QueueSnapshot => {
    if (this.#dirty) {
      this.#dirty = false;
      this.#snapshot = {
        items: this.#entries.map(viewOf),
        schedule: this.#schedule,
        busy: this.#busy,
      };
    }
    return this.#snapshot;
  };

  /**
   * Hears of changes, at most once every `NOTIFY_EVERY_MS` (the first at
   * once, in a microtask), so a run of uploads cannot keep the page busy
   * redrawing.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Hears at once when the queue starts or stops holding files to send (for `beforeunload`). */
  onBusyChange(listener: (busy: boolean) => void): () => void {
    this.#busyListeners.add(listener);
    return () => this.#busyListeners.delete(listener);
  }

  /**
   * Ends the queue, as on sign-out: every upload still to go is canceled
   * (a `PUT` in flight is aborted), every row goes, and nothing more is
   * reported.
   */
  dispose(): void {
    this.#disposed = true;
    for (const entry of this.#entries) {
      if (ACTIVE.has(entry.state)) {
        entry.state = "canceled";
      }
      entry.reported = true;
      entry.abort?.abort();
    }
    this.#entries = [];
    // The session is over, so a report would be refused: the cron's next
    // pass indexes what landed.
    this.#unreported = [];
    this.#landed = [];
    clearTimeout(this.#completeTimer);
    clearTimeout(this.#refreshTimer);
    this.#completeTimer = undefined;
    this.#refreshTimer = undefined;
    this.#emit();
  }

  /**
   * Queues the planned files, in order. A file the mirror refused is
   * Failed at once, with its reason, and never reaches the server.
   * `signBatch` is the server's `limits.signBatch`.
   */
  add(planned: readonly PlannedUpload[], signBatch: number): void {
    if (this.#disposed) {
      return;
    }
    this.#signBatch = Math.max(1, Math.floor(signBatch));
    for (const { file, prefix, key, refusal } of planned) {
      const entry: Entry = {
        id: this.#nextId++,
        file,
        prefix,
        key,
        size: file.size,
        state: "waiting",
        overwrite: false,
        loaded: 0,
        retried: false,
        resigned: false,
        reported: false,
        maybeLanded: false,
      };
      if (refusal !== null) {
        entry.state = "failed";
        entry.failure = { code: refusal };
      }
      this.#entries.push(entry);
    }
    this.#settle();
  }

  /** Replace: signs the file again with `overwrite: true`. Only ever the owner's choice. */
  replace(id: number): void {
    this.#replace(this.#entries.filter((entry) => entry.id === id));
  }

  /** Replace all: every file that already exists, after the owner confirmed it. */
  replaceAll(): void {
    this.#replace(this.#entries);
  }

  skip(id: number): void {
    this.#skip(this.#entries.filter((entry) => entry.id === id));
  }

  skipAll(): void {
    this.#skip(this.#entries);
  }

  /** Cancels a file that is waiting, being signed or being sent (its `PUT` is aborted). */
  cancel(id: number): void {
    this.#cancel(this.#entries.filter((entry) => entry.id === id));
  }

  cancelAll(): void {
    this.#cancel(this.#entries);
  }

  /** Takes the uploaded, failed, skipped and canceled rows away. */
  clearFinished(): void {
    this.#entries = this.#entries.filter((entry) => !FINISHED.has(entry.state));
    this.#emit();
  }

  /**
   * Reports at once every landed key still held: for `pagehide`, so a tab
   * closed mid-way still tells the server about the files that did land
   * (the cron's next pass would find them anyway).
   */
  flush(): void {
    this.#reportHeld();
  }

  #replace(entries: readonly Entry[]): void {
    for (const entry of entries) {
      if (entry.state === "exists") {
        Object.assign(entry, {
          state: "waiting",
          overwrite: true,
          retried: false,
          resigned: false,
        });
        entry.reported = false;
        entry.existing = undefined;
      }
    }
    this.#settle();
  }

  #skip(entries: readonly Entry[]): void {
    for (const entry of entries) {
      if (entry.state === "exists") {
        entry.state = "skipped";
        entry.reported = true;
        // An answer lost after R2 took the file: what exists may be this
        // upload, which the server has not heard of yet.
        if (entry.maybeLanded) {
          this.#hold(entry.key);
        }
      }
    }
    this.#settle();
  }

  #cancel(entries: readonly Entry[]): void {
    for (const entry of entries) {
      if (ACTIVE.has(entry.state)) {
        entry.state = "canceled";
        entry.reported = true;
        entry.abort?.abort();
      }
    }
    this.#settle();
  }

  /** Signs the next files for the free places, one request per folder prefix. */
  #pump(): void {
    let free = UPLOADS_AT_ONCE - this.#entries.filter((entry) => IN_FLIGHT.has(entry.state)).length;
    while (free > 0) {
      const busyKeys = new Set(
        this.#entries.filter((entry) => IN_FLIGHT.has(entry.state)).map((e) => sameKey(e.key)),
      );
      const limit = Math.min(free, this.#signBatch);
      const batch: Entry[] = [];
      for (const entry of this.#entries) {
        if (batch.length >= limit) {
          break;
        }
        const key = sameKey(entry.key);
        if (
          entry.state === "waiting" &&
          !busyKeys.has(key) &&
          (batch.length === 0 || entry.prefix === batch[0]?.prefix)
        ) {
          busyKeys.add(key);
          batch.push(entry);
        }
      }
      if (batch.length === 0) {
        return;
      }
      free -= batch.length;
      for (const entry of batch) {
        entry.state = "signing";
      }
      void this.#sign(batch);
    }
  }

  async #sign(batch: readonly Entry[]): Promise<void> {
    const prefix = batch[0]?.prefix ?? "";
    let result: SignUploadsResult;
    try {
      result = await this.#calls.sign(
        prefix,
        batch.map(({ key, size, overwrite }) => ({ key, size, overwrite })),
      );
    } catch (error) {
      if (this.#disposed) {
        return;
      }
      this.#hooks.onError?.(error);
      // A refusal of the whole request (signed out, writes off, uploads not
      // configured) would meet every file waiting too.
      const failing = refusesEveryFile(error)
        ? this.#entries.filter((entry) => entry.state === "waiting" || batch.includes(entry))
        : batch;
      for (const entry of failing) {
        if (entry.state === "signing" || entry.state === "waiting") {
          this.#fail(entry, { code: "sign_failed", error });
        }
      }
      this.#settle();
      return;
    }

    if (this.#disposed) {
      return;
    }
    const signed: [Entry, PresignedUpload][] = [];
    batch.forEach((entry, index) => {
      const answer = result.uploads[index];
      if (entry.state !== "signing") {
        // Canceled while it was being signed.
        return;
      }
      if (answer === undefined) {
        this.#fail(entry, { code: "sign_failed", error: new Error("No answer for this file") });
        return;
      }
      entry.key = answer.key;
      if ("url" in answer) {
        signed.push([entry, answer]);
      } else if (answer.error === "exists") {
        entry.state = "exists";
        entry.existing = answer.existing;
      } else {
        this.#fail(entry, { code: answer.error });
      }
    });
    for (const [entry, upload] of signed) {
      this.#put(entry, upload, result.clock);
    }
    this.#settle();
  }

  /** Sends one signed file, unless its URL is too close to its expiry, which is signed again. */
  #put(entry: Entry, upload: PresignedUpload, clock: ServerClock): void {
    if (this.#disposed) {
      return;
    }
    const serverNow = Date.parse(clock.serverTime) + (this.#now() - clock.receivedAt);
    if (Date.parse(upload.expiresAt) - serverNow < EXPIRY_MARGIN_MS && !entry.resigned) {
      entry.resigned = true;
      entry.state = "waiting";
      return;
    }

    entry.state = "uploading";
    entry.loaded = 0;
    const abort = new AbortController();
    entry.abort = abort;
    const onProgress = (loaded: number) => {
      if (entry.state !== "uploading") {
        return;
      }
      const before = percentOf(entry);
      entry.loaded = Math.min(Math.max(loaded, 0), entry.size);
      if (percentOf(entry) !== before) {
        this.#changed();
      }
    };
    void this.#calls
      .put(upload, entry.file, onProgress, abort.signal)
      .catch(() => 0)
      .then((status) => {
        entry.abort = undefined;
        if (this.#disposed || entry.state !== "uploading") {
          // Canceled while it was being sent.
          return;
        }
        if (status >= 200 && status < 300) {
          entry.state = "uploaded";
          entry.loaded = entry.size;
          this.#hold(entry.key);
          this.#landed.push(entry.key);
          this.#refreshSoon();
        } else if (status === 412) {
          // The key appeared after the server looked: If-None-Match held.
          entry.state = "exists";
        } else if ((status === 0 || status === 403) && !entry.retried) {
          // A network error (an expired URL has no CORS headers) or a 403:
          // signed again and tried once more.
          entry.retried = true;
          entry.maybeLanded ||= status === 0;
          entry.state = "waiting";
        } else {
          this.#fail(entry, { code: "put_failed", status });
        }
        this.#settle();
      });
  }

  #fail(entry: Entry, failure: UploadFailure): void {
    entry.state = "failed";
    entry.failure = failure;
  }

  /**
   * Holds a landed key for the next report: at once when `signBatch` keys
   * wait, else once `COMPLETE_QUIET_MS` pass with nothing new landing.
   */
  #hold(key: string): void {
    this.#unreported.push(key);
    clearTimeout(this.#completeTimer);
    this.#completeTimer = undefined;
    if (this.#unreported.length >= this.#signBatch) {
      this.#reportHeld();
    } else {
      this.#completeTimer = setTimeout(() => {
        this.#completeTimer = undefined;
        this.#reportHeld();
        this.#settle();
      }, COMPLETE_QUIET_MS);
    }
  }

  /** Reports every held key now. */
  #reportHeld(): void {
    clearTimeout(this.#completeTimer);
    this.#completeTimer = undefined;
    this.#report(this.#unreported.splice(0));
  }

  /** `POST /api/files/uploads/complete` for these keys, at most `signBatch` a request. */
  #report(keys: readonly string[]): void {
    if (this.#disposed) {
      return;
    }
    for (let start = 0; start < keys.length; start += this.#signBatch) {
      this.#completing++;
      this.#calls
        .complete(keys.slice(start, start + this.#signBatch))
        .then(
          ({ scan, clock }) => {
            this.#schedule = { scan, clock };
            this.#scanUnknown ||= scan === null;
          },
          (error: unknown) => {
            // The files are in the bucket either way; the cron's next pass
            // indexes them.
            this.#scanUnknown = true;
            this.#hooks.onError?.(error);
          },
        )
        .finally(() => {
          this.#completing--;
          if (!this.#disposed) {
            this.#settle();
          }
        });
    }
  }

  /** At most once every `REFRESH_EVERY_MS`, and once more after the last upload of a burst. */
  #refreshSoon(): void {
    if (this.#disposed || this.#refreshTimer !== undefined) {
      return;
    }
    const wait = this.#lastRefresh + REFRESH_EVERY_MS - this.#now();
    const refresh = () => {
      this.#refreshTimer = undefined;
      if (this.#disposed) {
        return;
      }
      this.#lastRefresh = this.#now();
      this.#hooks.onRefresh?.(this.#landed.splice(0));
    };
    if (wait <= 0) {
      refresh();
    } else {
      this.#refreshTimer = setTimeout(refresh, wait);
    }
  }

  /** Starts what can start, and, once nothing is left to run, says what the run did. */
  #settle(): void {
    this.#pump();
    const running =
      this.#entries.some((entry) => ACTIVE.has(entry.state)) ||
      this.#unreported.length > 0 ||
      this.#completing > 0;
    if (!running) {
      const settled = this.#entries.filter(
        (entry) =>
          !entry.reported &&
          (entry.state === "uploaded" || entry.state === "failed" || entry.state === "exists"),
      );
      if (settled.length > 0) {
        for (const entry of settled) {
          entry.reported = true;
        }
        const conflicts = settled.filter((entry) => entry.state === "exists").length;
        const uploaded = settled.filter((entry) => entry.state === "uploaded").length;
        const summary: RunSummary = {
          uploaded,
          notUploaded: settled.length - uploaded,
          conflicts,
          scanUnknown: this.#scanUnknown,
        };
        this.#scanUnknown = false;
        this.#hooks.onDrained?.(summary);
      }
    }
    this.#emit();
  }

  /** After a change of state: whether the queue is busy, and the listeners. */
  #emit(): void {
    const busy = this.#entries.some((entry) => ACTIVE.has(entry.state));
    if (busy !== this.#busy) {
      this.#busy = busy;
      for (const listener of this.#busyListeners) {
        listener(busy);
      }
    }
    this.#changed();
  }

  /** The snapshot is stale: listeners hear of it, throttled. */
  #changed(): void {
    this.#dirty = true;
    if (this.#notifyQueued) {
      return;
    }
    this.#notifyQueued = true;
    const notify = () => {
      this.#notifyQueued = false;
      this.#lastNotify = Date.now();
      for (const listener of this.#listeners) {
        listener();
      }
    };
    const wait = this.#lastNotify + NOTIFY_EVERY_MS - Date.now();
    if (wait <= 0) {
      queueMicrotask(notify);
    } else {
      setTimeout(notify, wait);
    }
  }
}

/** An entry's row: the one it had while nothing on it changed, so a memoised row skips its redraw. */
function viewOf(entry: Entry): UploadView {
  const view = entry.view;
  if (
    view !== undefined &&
    view.key === entry.key &&
    view.loaded === entry.loaded &&
    view.state === entry.state &&
    view.failure === entry.failure &&
    view.existing === entry.existing
  ) {
    return view;
  }
  entry.view = {
    id: entry.id,
    key: entry.key,
    size: entry.size,
    loaded: entry.loaded,
    state: entry.state,
    ...(entry.failure ? { failure: entry.failure } : {}),
    ...(entry.existing ? { existing: entry.existing } : {}),
  };
  return entry.view;
}

/** An upload's progress, in whole percent: 100 for an empty file. */
export function percentOf({ loaded, size }: { loaded: number; size: number }): number {
  return size === 0 ? 100 : Math.floor((loaded * 100) / size);
}

/**
 * Sends one presigned `PUT` with `XMLHttpRequest`, for `upload.onprogress`
 * (a `fetch` body reports no upload progress), with exactly the signed
 * headers: the browser sets `Content-Length` from the file itself. It
 * answers the status, or 0 for a network error, a timeout or an abort.
 */
export function xhrPut(
  upload: PresignedUpload,
  body: Blob,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<number> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open(upload.method, upload.url);
    for (const [name, value] of Object.entries(upload.headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => resolve(xhr.status);
    xhr.onerror = () => resolve(0);
    xhr.ontimeout = () => resolve(0);
    xhr.onabort = () => resolve(0);
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/**
 * Keeps the page honest while uploads run: `beforeunload` asks before the
 * tab closes while a file is waiting or being sent (the listener is there
 * only then, so the page stays eligible for the back-forward cache), and
 * `pagehide` reports the uploads that landed but were not reported yet
 * (`flush`). Answers the function that stops watching.
 */
export function watchPage(
  queue: UploadQueue,
  target: Pick<Window, "addEventListener" | "removeEventListener">,
): () => void {
  const warn = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    // Older browsers ask for a return value as well.
    event.returnValue = "";
  };
  const follow = (busy: boolean) => {
    if (busy) {
      target.addEventListener("beforeunload", warn);
    } else {
      target.removeEventListener("beforeunload", warn);
    }
  };
  const flush = () => queue.flush();
  target.addEventListener("pagehide", flush);
  const unsubscribe = queue.onBusyChange(follow);
  follow(queue.getSnapshot().busy);
  return () => {
    unsubscribe();
    target.removeEventListener("pagehide", flush);
    target.removeEventListener("beforeunload", warn);
  };
}

/* ---------------------------------------------------------------- rows -- */

/** The most finished rows the Uploads section shows: the latest ones. */
export const SHOWN_FINISHED = 50;

/** The most waiting rows the Uploads section shows: the next ones. */
export const SHOWN_WAITING = 50;

/** The rows the Uploads section shows, and how many of each kind it leaves out. */
export interface ShownRows {
  rows: UploadView[];
  hidden: { uploaded: number; skipped: number; canceled: number; waiting: number };
}

/**
 * Which rows to draw, in queue order: every file being signed or sent,
 * every failure and every conflict (they need the owner), the next
 * `SHOWN_WAITING` waiting files and the latest `SHOWN_FINISHED` uploaded,
 * skipped or canceled ones. The rest are counted, so a pick of 2,000 files
 * draws about a hundred rows.
 */
export function shownRows(
  items: readonly UploadView[],
  limits: { finished: number; waiting: number } = {
    finished: SHOWN_FINISHED,
    waiting: SHOWN_WAITING,
  },
): ShownRows {
  const done = items.filter(
    (item) => item.state === "uploaded" || item.state === "skipped" || item.state === "canceled",
  );
  const kept = new Set(done.slice(Math.max(done.length - limits.finished, 0)));
  const hidden = { uploaded: 0, skipped: 0, canceled: 0, waiting: 0 };
  let waiting = 0;
  const rows = items.filter((item) => {
    switch (item.state) {
      case "waiting":
        waiting++;
        if (waiting <= limits.waiting) {
          return true;
        }
        hidden.waiting++;
        return false;
      case "uploaded":
      case "skipped":
      case "canceled":
        if (kept.has(item)) {
          return true;
        }
        hidden[item.state]++;
        return false;
      default:
        return true;
    }
  });
  return { rows, hidden };
}

/**
 * The lines that count the rows left out. `earlier` stands for the older
 * finished files, so it goes above the rows (`1,950 more uploaded
 * earlier`, with skipped and canceled ones); `later` for the waiting files
 * past the shown ones, below them (`and 300 more waiting`).
 */
export function describeHidden(hidden: ShownRows["hidden"]): {
  earlier: string | null;
  later: string | null;
} {
  const parts = (["uploaded", "skipped", "canceled"] as const)
    .filter((state) => hidden[state] > 0)
    .map((state, index) => `${formatCount(hidden[state])}${index === 0 ? " more" : ""} ${state}`);
  const last = parts.pop();
  return {
    earlier:
      last === undefined
        ? null
        : `${parts.length > 0 ? `${parts.join(", ")} and ${last}` : last} earlier`,
    later: hidden.waiting > 0 ? `and ${formatCount(hidden.waiting)} more waiting` : null,
  };
}

/* --------------------------------------------------------------- words -- */

/** The Uploads section's description: `4 of 12 uploaded`, skipped and canceled files left out. */
export function describeQueue(items: readonly UploadView[]): string {
  const counted = items.filter((item) => item.state !== "skipped" && item.state !== "canceled");
  const uploaded = counted.filter((item) => item.state === "uploaded").length;
  return `${uploaded.toLocaleString("en")} of ${counted.length.toLocaleString("en")} uploaded`;
}

/** Why a file failed, for its row: short, after `Failed: `. */
export function describeFailure(
  failure: UploadFailure,
  key: string,
  config: Pick<FilesConfig, "allowed" | "limits"> | undefined,
): string {
  switch (failure.code) {
    case "type_not_allowed":
      return "not a type the server reads";
    case "too_large": {
      const kind = config ? kindOfSuffix(suffixOf(key), config.allowed) : null;
      return kind && config
        ? `over ${formatBytes(config.allowed[kind].maxBytes, 2)}, the most for its type (use rclone for larger files)`
        : "over the most the server takes for its type";
    }
    case "empty_file":
      return "the file is empty";
    case "invalid_path":
      return "not a name the bucket takes";
    case "path_too_long":
      return config
        ? `the path is over ${formatCount(config.limits.maxKeyBytes)} bytes, or a name in it over ${formatCount(config.limits.maxSegmentBytes)}`
        : "the path or a name in it is too long";
    case "reserved_path":
      return "_covers/ is the scanner's own folder";
    case "replace_unavailable":
      return "it cannot be replaced from here; replace it with rclone";
    case "put_failed":
      return failure.status === 0
        ? "the upload did not reach the bucket"
        : `the bucket answered ${failure.status}`;
    case "sign_failed":
      return failure.error instanceof ApiError && failure.error.code === "network"
        ? "the server could not be reached"
        : failure.error instanceof ApiError
          ? `the server refused it (${failure.error.code})`
          : "the server's answer was not understood";
  }
}

/** The toast after a run that uploaded something. */
export function uploadedToast(summary: RunSummary): { title: string; description: string } {
  return {
    title: `Uploaded ${countOf(summary.uploaded, "file")}`,
    description: summary.scanUnknown
      ? `The next scheduled scan will index ${summary.uploaded === 1 ? "it" : "them"}.`
      : "Tracks join the library at the next scan.",
  };
}

/** The toast after a run that left files out. */
export function notUploadedToast(summary: RunSummary): { title: string; description: string } {
  const verb = summary.notUploaded === 1 ? "was" : "were";
  return {
    title: `${countOf(summary.notUploaded, "file")} ${verb} not uploaded`,
    description:
      summary.conflicts > 0
        ? "Uploads lists why. Replace or skip the files that already exist."
        : "Uploads lists why.",
  };
}
