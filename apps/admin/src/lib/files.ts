import {
  type InfiniteData,
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";

import {
  type DeleteFilesResult,
  type DeleteFolderResult,
  type FilesConfig,
  type FilesLibrary,
  type FolderListing,
  fetchFiles,
  fetchFilesConfig,
  type ScanSchedule,
  type ServerClock,
} from "@/lib/api";
import { formatCount } from "@/lib/format";
import { aboutMinutes, type LiveRead, libraryParam, scheduleState } from "@/lib/overview";

/**
 * The Files page's rules that need no screen (#83, "Console"): how it reads
 * the bucket, the folder path, the New folder name check, how a delete is
 * split into requests and what it says, and the scan line.
 *
 * ## Reads
 *
 * | Query | `staleTime` | Read again |
 * |---|---|---|
 * | `/api/files/config` | `Infinity` | once a session, and after a library write |
 * | `/api/files?library=&prefix=` | 30 s | on open once stale, on Load more, and after every delete (open and delete read the first page only) |
 * | `/api/overview/live` | 0, as the Overview's | only while a scan is scheduled or running, with `library:read` |
 *
 * Nothing is polled while no scan is scheduled or running, and a hidden tab
 * reads nothing (`refetchIntervalInBackground: false`, the live query's own).
 */

/** How long a folder's listing stays fresh: only the console, a pass's covers and rclone change it. */
export const FOLDER_STALE_MS = 30_000;

/** The bucket's name when the server does not know it (`R2_BUCKET_NAME` unset). */
export const BUCKET_FALLBACK = "Bucket";

/** Library 1, the bucket the Worker is bound to: the Files page's library by default (#84). */
export const BOUND_LIBRARY = 1;

/** Library 1's reserved prefix, as the server names it, for a configuration that names none. */
const BOUND_RESERVED = ["_covers/"];

/**
 * A library as the Files page sees it, from `GET /api/files/config`, or
 * `undefined` for one the server does not list (removed, or never there).
 */
export function filesLibrary(
  config: Pick<FilesConfig, "libraries"> | undefined,
  library: number,
): FilesLibrary | undefined {
  return config?.libraries.find((entry) => entry.id === library);
}

/**
 * What the Files page may do in a library (#84): write (delete, New
 * folder) where the server takes file writes and the library is not
 * read-only, and upload where its uploads can be signed too. A library the
 * configuration does not list takes nothing.
 */
export function libraryWrites(
  config: Pick<FilesConfig, "writes" | "libraries"> | undefined,
  library: number,
): { writable: boolean; uploads: boolean; readOnly: boolean; uploadsMissing: boolean } {
  const entry = filesLibrary(config, library);
  const enabled = config?.writes.enabled === true && entry !== undefined;
  const writable = enabled && entry.writable;
  return {
    writable,
    uploads: writable && entry.uploads.configured,
    readOnly: enabled && !entry.writable,
    uploadsMissing: writable && !entry.uploads.configured,
  };
}

/** The prefixes no write may touch in a library: library 1's `_covers/` (#84, "Covers"). */
export function reservedPrefixesOf(
  config: Pick<FilesConfig, "libraries"> | undefined,
  library: number,
): readonly string[] {
  return (
    filesLibrary(config, library)?.reservedPrefixes ??
    (library === BOUND_LIBRARY ? BOUND_RESERVED : [])
  );
}

export const filesConfigQuery = queryOptions({
  queryKey: ["files", "config"],
  queryFn: fetchFilesConfig,
  staleTime: Number.POSITIVE_INFINITY,
});

/** Every folder listing in the cache, whatever its prefix. */
const FOLDERS_KEY = ["files", "folder"] as const;

/** Every folder listing of one library in the cache. */
function libraryFoldersKey(library: number) {
  return [...FOLDERS_KEY, library] as const;
}

/**
 * One folder of a library's bucket, a page of 1,000 entries at a time: Load
 * more reads the next page with the bucket's cursor while there is one. R2
 * gives no total.
 */
export function folderQuery(library: number, prefix: string) {
  return infiniteQueryOptions({
    queryKey: [...libraryFoldersKey(library), prefix],
    queryFn: ({ pageParam }) => fetchFiles(library, prefix, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last: FolderListing) => last.cursor,
    staleTime: FOLDER_STALE_MS,
    // A return to the tab is no change to the bucket: the page reads it on
    // open, on Load more and after a change only.
    refetchOnWindowFocus: false,
  });
}

/** A listing cut back to its first page, so that reading it again costs one request. */
function firstPage<TPageParam>(
  data: InfiniteData<FolderListing, TPageParam> | undefined,
): InfiniteData<FolderListing, TPageParam> | undefined {
  return data && data.pages.length > 1
    ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
    : data;
}

/**
 * After a delete in a library: every folder of it read so far is out of
 * date (a folder deleted from its parent took its subfolders with it), so
 * each is cut back to its first page and marked stale, and the folder on
 * screen is read again at once, in one request whatever pages were loaded.
 * Other libraries' folders keep theirs.
 */
export function afterFilesChange(queryClient: QueryClient, library: number): Promise<void> {
  const queryKey = libraryFoldersKey(library);
  queryClient.setQueriesData<InfiniteData<FolderListing, string | null>>({ queryKey }, firstPage);
  return queryClient.invalidateQueries({ queryKey });
}

/** A key of one library's bucket. */
export interface LibraryKey {
  library: number;
  key: string;
}

/**
 * After uploads landed (lib/uploads.ts, at most once every 5 s): only the
 * folders the keys change, in the keys' own libraries, are read again, each
 * cut back to its first page. A folder is changed by a key directly in it,
 * or by one under a subfolder its loaded pages do not list yet (which the
 * upload made). Every other folder, the one on screen included, keeps its
 * pages, Load more and all.
 */
export function afterUploadsLanded(
  queryClient: QueryClient,
  landed: readonly LibraryKey[],
): Promise<void> {
  const changed = queryClient
    .getQueriesData<InfiniteData<FolderListing, string | null>>({ queryKey: FOLDERS_KEY })
    .filter(([queryKey, data]) => {
      const library = queryKey[FOLDERS_KEY.length];
      const prefix = queryKey[FOLDERS_KEY.length + 1];
      return (
        typeof prefix === "string" &&
        landed.some((entry) => entry.library === library && changesFolder(prefix, entry.key, data))
      );
    });
  return Promise.all(
    changed.map(([queryKey]) => {
      queryClient.setQueryData(queryKey, firstPage);
      return queryClient.invalidateQueries({ queryKey, exact: true });
    }),
  ).then(() => undefined);
}

/** Whether a key that landed changes the listing of the folder `prefix`. */
function changesFolder(
  prefix: string,
  key: string,
  data: InfiniteData<FolderListing, string | null> | undefined,
): boolean {
  if (!key.startsWith(prefix)) {
    return false;
  }
  const rest = key.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    return true;
  }
  const folder = `${prefix}${rest.slice(0, slash + 1)}`;
  return !(data?.pages ?? []).some((page) => page.folders.some((f) => f.prefix === folder));
}

/**
 * A cursor R2 refused (`invalid_cursor`): the folder is opened again from its
 * first page.
 */
export function reopenFolder(
  queryClient: QueryClient,
  library: number,
  prefix: string,
): Promise<void> {
  const { queryKey } = folderQuery(library, prefix);
  queryClient.setQueryData(queryKey, firstPage);
  return queryClient.refetchQueries({ queryKey, exact: true });
}

/**
 * When the page leaves a folder (for another, or for another page), the
 * folder's listing is cut back to its first page: an infinite query read
 * again reads every page it holds, so a return to it once stale reads one
 * page, not every page Load more had added. A return within 30 s shows the
 * first page from the cache, and Load more reads on from there.
 */
export function leaveFolder(queryClient: QueryClient, library: number, prefix: string): void {
  queryClient.setQueryData(folderQuery(library, prefix).queryKey, firstPage);
}

/** The ids of every row a folder's loaded pages show (`targetId`). */
export function shownIds(data: InfiniteData<FolderListing, unknown> | undefined): Set<string> {
  return new Set(
    (data?.pages ?? []).flatMap((page) => [
      ...page.folders.map((folder) => folder.prefix),
      ...page.files.map((file) => file.key),
    ]),
  );
}

/** A copy of `selection` without the ids `keep` turns down. */
export function selectionWhere<T>(
  selection: ReadonlyMap<string, T>,
  keep: (id: string) => boolean,
): Map<string, T> {
  return new Map([...selection].filter(([id]) => keep(id)));
}

/**
 * The rows chosen for a delete, by `targetId`, with the folder they were
 * chosen in. The page clears it when it leaves the folder (whose listing
 * `leaveFolder` cuts back to its first page), so nothing chosen on a later
 * page survives a return.
 */
export interface Selection {
  prefix: string | null;
  targets: ReadonlyMap<string, DeleteTarget>;
}

/** Nothing selected, in no folder: the page's state at first and after it leaves a folder. */
export const NO_SELECTION: Selection = { prefix: null, targets: new Map() };

/** `selection` with `targets` checked or unchecked in the folder `prefix`, starting afresh in another. */
export function toggleSelected(
  selection: Selection,
  prefix: string,
  targets: readonly DeleteTarget[],
  checked: boolean,
): Selection {
  const next = new Map(selection.prefix === prefix ? selection.targets : NO_SELECTION.targets);
  for (const target of targets) {
    if (checked) {
      next.set(targetId(target), target);
    } else {
      next.delete(targetId(target));
    }
  }
  return { prefix, targets: next };
}

/**
 * What a delete of the selection would take: the selected rows of the
 * folder `prefix` that the page shows now (`shownIds`), and nothing else.
 * Deletes are permanent, so a row that is not on screen (another folder's,
 * or one of a page no longer loaded) is never counted, checked or deleted,
 * whatever the state still holds.
 */
export function selectedIn(
  selection: Selection,
  prefix: string,
  shown: ReadonlySet<string>,
): ReadonlyMap<string, DeleteTarget> {
  return selection.prefix === prefix
    ? selectionWhere(selection.targets, (id) => shown.has(id))
    : NO_SELECTION.targets;
}

/** The Files page's search parameters: the library (absent for library 1) and the folder. */
export interface FilesSearch {
  library?: number;
  prefix?: string;
}

/**
 * The search parameters of `/files`:
 *
 * - `?library=`: the library browsed (#84), a positive integer, or absent
 *   for library 1, so a single-library console's links are as they were.
 *   Anything else opens library 1.
 * - `?prefix=`: a folder's prefix, ending in `/`, or absent for the root.
 *   A deep link that names a folder without its final slash gets it. The
 *   router parses each search value as JSON first, so `?prefix=2024`
 *   arrives as the number 2024, and `?prefix=true` as a boolean: both are
 *   taken back as folder names. A hand-typed number that JSON writes
 *   another way does not survive that parse (`?prefix=1.50` opens `1.5/`);
 *   the page's own links always end in `/`, which no JSON parse accepts, so
 *   they arrive as typed. Anything else that is not a string opens the root.
 */
export function validateFilesSearch(search: Record<string, unknown>): FilesSearch {
  const library = libraryParam(search.library);
  return {
    ...(library === undefined || library === BOUND_LIBRARY ? {} : { library }),
    ...folderParam(search.prefix),
  };
}

/** A folder's search parameters, in a library: none for library 1's root. */
export function filesSearch(library: number, prefix: string): FilesSearch {
  return {
    ...(library === BOUND_LIBRARY ? {} : { library }),
    ...(prefix === "" ? {} : { prefix }),
  };
}

function folderParam(raw: unknown): { prefix?: string } {
  const prefix =
    typeof raw === "string"
      ? raw
      : (typeof raw === "number" && Number.isFinite(raw)) || typeof raw === "boolean"
        ? String(raw)
        : "";
  if (prefix === "") {
    return {};
  }
  return { prefix: prefix.endsWith("/") ? prefix : `${prefix}/` };
}

/** The folders from the root to `prefix`, each with its own prefix: `A/`, then `A/B/`. */
export function folderTrail(prefix: string): { name: string; prefix: string }[] {
  const names = prefix.split("/").slice(0, -1);
  return names.map((name, index) => ({
    name,
    prefix: `${names.slice(0, index + 1).join("/")}/`,
  }));
}

/** A folder as a toast names it: its path without the final slash, `Artist/Album`. */
export function folderPath(prefix: string): string {
  return prefix.replace(/\/$/, "");
}

/** `1 file`, `2,000 files`. */
export function countOf(count: number, noun: string): string {
  return `${formatCount(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What the loaded pages hold, for the folder section's description: `2
 * folders and 12 files`, with `so far` while Load more has more.
 */
export function describeListing(folders: number, files: number, more: boolean): string {
  const parts = [
    folders > 0 || files === 0 ? countOf(folders, "folder") : null,
    files > 0 || folders === 0 ? countOf(files, "file") : null,
  ].filter((part) => part !== null);
  return `${parts.join(" and ")}${more ? " so far" : ""}`;
}

/** The characters no new key's segment may hold: controls, and a Windows path's backslash. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
export const FORBIDDEN_CHARACTERS = /[\u0000-\u001f\u007f\\]/;

/** The length of a string in bytes of UTF-8, as R2 counts a key. */
export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Checks a New folder name against the server's rules for a new key's segment
 * (apps/server `files/keys.ts`), and answers the folder's prefix, or why the
 * name is refused, in words for beside the field. The name is written in
 * NFC, as the server writes every new key. It is also trimmed, which is the
 * console's own choice, not a server rule: the server keeps spaces at either
 * end of a segment, but a folder name typed with one is almost always a slip.
 * Nothing is written: R2 has no folders, so the folder exists once a file
 * lands in it. `reserved` is the library's reserved prefixes: library 1's
 * `_covers/` (#84), and none in a connected bucket.
 */
export function checkFolderName(
  raw: string,
  prefix: string,
  limits: Pick<FilesConfig["limits"], "maxKeyBytes" | "maxSegmentBytes">,
  reserved: readonly string[] = BOUND_RESERVED,
): { prefix: string } | { error: string } {
  const name = raw.trim().normalize("NFC");
  if (name === "") {
    return { error: "Enter a name." };
  }
  if (name.includes("/")) {
    return { error: "A name cannot contain a slash. Make one folder at a time." };
  }
  if (name.startsWith(".")) {
    return { error: "A name cannot start with a dot." };
  }
  if (FORBIDDEN_CHARACTERS.test(name)) {
    return { error: "A name cannot contain a backslash or a control character." };
  }
  if (utf8Length(name) > limits.maxSegmentBytes) {
    return {
      error: `The name is too long: at most ${formatCount(limits.maxSegmentBytes)} bytes.`,
    };
  }
  const folder = `${prefix}${name}/`;
  if (utf8Length(folder) > limits.maxKeyBytes) {
    return {
      error: `The folder's path would be too long: at most ${formatCount(limits.maxKeyBytes)} bytes.`,
    };
  }
  const covered = reserved.find((reservedPrefix) => folder.startsWith(reservedPrefix));
  if (covered !== undefined) {
    return { error: `${folderPath(covered)} is the scanner's own folder.` };
  }
  return { prefix: folder };
}

/** A file or folder the owner chose to delete, with the name its folder lists it by. */
export type DeleteTarget =
  | { type: "file"; key: string; name: string }
  | { type: "folder"; prefix: string; name: string };

/** A target's identity in a selection: a file's key, or a folder's prefix (which ends in `/`). */
export function targetId(target: DeleteTarget): string {
  return target.type === "file" ? target.key : target.prefix;
}

/** How a delete goes out: files in requests of at most `batch` keys, then each folder. */
export interface DeletePlan {
  fileBatches: string[][];
  folders: string[];
}

/**
 * Splits the targets into requests: the files' keys in batches of at most
 * `batch` (`POST /api/files/delete` takes 250), and the folders, which are
 * deleted one after another, each by `delete-folder` rounds until `done`.
 */
export function planDelete(targets: readonly DeleteTarget[], batch: number): DeletePlan {
  const keys = [...new Set(targets.flatMap((t) => (t.type === "file" ? [t.key] : [])))];
  const folders = [...new Set(targets.flatMap((t) => (t.type === "folder" ? [t.prefix] : [])))];
  const size = Math.max(Math.floor(batch), 1);
  const fileBatches: string[][] = [];
  for (let start = 0; start < keys.length; start += size) {
    fileBatches.push(keys.slice(start, start + size));
  }
  return { fileBatches, folders };
}

/** What the last write that changed the bucket said the scan will do, with its clock. */
export interface WriteSchedule {
  scan: ScanSchedule | null;
  clock: ServerClock;
}

/** What a delete did, as far as it got. */
export interface DeleteOutcome {
  /** Files deleted by key. */
  files: number;
  /** Each folder reached, with the files deleted under it. */
  folders: { prefix: string; deleted: number }[];
  /**
   * The schedule the last answer that carried one gave, or `undefined` when
   * none did, so the page keeps the one it had.
   */
  schedule: WriteSchedule | undefined;
  /**
   * The targets it is done with, by `targetId`: the keys of every batch the
   * server answered, and each folder whose rounds reached `done`. A folder
   * a failure stopped part way is not among them, so it stays selected for
   * another try.
   */
  reached: string[];
  /** Why it stopped before the end, if it did. */
  error?: unknown;
}

export interface DeleteCalls {
  deleteFiles: (keys: readonly string[]) => Promise<DeleteFilesResult>;
  deleteFolderRound: (prefix: string) => Promise<DeleteFolderResult>;
}

/** Every file a delete has taken so far. */
export function deletedCount(outcome: Pick<DeleteOutcome, "files" | "folders">): number {
  return outcome.folders.reduce((sum, folder) => sum + folder.deleted, outcome.files);
}

/**
 * Runs a delete, one request at a time: the batches of files, then each
 * folder by rounds until the server says `done`. `onProgress` hears the files
 * deleted so far after each answer. A round with no `scan` key (one that
 * found nothing left to delete) keeps the schedule of the answer before it;
 * `scan: null` is a schedule too (the driver could not be told). A failed
 * request stops the delete, and the outcome says how far it got.
 */
export async function runDelete(
  plan: DeletePlan,
  calls: DeleteCalls,
  onProgress: (deleted: number) => void = () => {},
): Promise<DeleteOutcome> {
  const outcome: DeleteOutcome = { files: 0, folders: [], schedule: undefined, reached: [] };
  try {
    for (const keys of plan.fileBatches) {
      const result = await calls.deleteFiles(keys);
      outcome.files += result.deleted;
      outcome.schedule = { scan: result.scan, clock: result.clock };
      outcome.reached.push(...keys);
      onProgress(deletedCount(outcome));
    }
    for (const prefix of plan.folders) {
      const folder = { prefix, deleted: 0 };
      outcome.folders.push(folder);
      for (;;) {
        const result = await calls.deleteFolderRound(prefix);
        folder.deleted += result.deleted;
        if (result.scan !== undefined) {
          outcome.schedule = { scan: result.scan, clock: result.clock };
        }
        onProgress(deletedCount(outcome));
        if (result.done) {
          outcome.reached.push(prefix);
          break;
        }
      }
    }
  } catch (error) {
    outcome.error = error;
  }
  return outcome;
}

/** The delete dialog's title: `Delete 3 files and 1 folder?`. */
export function deleteTitle(targets: readonly DeleteTarget[]): string {
  const folders = targets.filter((target) => target.type === "folder").length;
  const files = targets.length - folders;
  const parts = [
    files > 0 ? countOf(files, "file") : null,
    folders > 0 ? countOf(folders, "folder") : null,
  ].filter((part) => part !== null);
  return `Delete ${parts.join(" and ")}?`;
}

/** The most names the delete dialog lists before `and 12 more`. */
export const LISTED_NAMES = 5;

/** The delete dialog's names, folders with their final slash, and how many more there are. */
export function listedNames(targets: readonly DeleteTarget[]): { names: string[]; more: number } {
  const names = targets
    .slice(0, LISTED_NAMES)
    .map((target) => (target.type === "folder" ? `${target.name}/` : target.name));
  return { names, more: Math.max(targets.length - LISTED_NAMES, 0) };
}

/**
 * The dialog's last sentences: that the delete is permanent (owner decision
 * 1), and when tracks leave the library, after the server's quiet window.
 */
export function deleteConsequences(rescanQuietSeconds: number): string {
  const minutes = Math.max(Math.round(rescanQuietSeconds / 60), 1);
  return `This cannot be undone. Tracks leave the library at the next scan, ${aboutMinutes(minutes)} after your last change.`;
}

/**
 * The toast of a delete: `Deleted 4 files`, `Deleted Artist/Album (532
 * files)`, `Deleted 4 files and 2 folders (1,064 files)`.
 */
export function deletedTitle(outcome: Pick<DeleteOutcome, "files" | "folders">): string {
  const { files, folders } = outcome;
  const inFolders = folders.reduce((sum, folder) => sum + folder.deleted, 0);
  const [only] = folders;
  const folderPart =
    folders.length === 0
      ? null
      : folders.length === 1 && only
        ? `${folderPath(only.prefix)} (${countOf(inFolders, "file")})`
        : `${countOf(folders.length, "folder")} (${countOf(inFolders, "file")})`;
  if (folderPart === null) {
    return `Deleted ${countOf(files, "file")}`;
  }
  return files > 0
    ? `Deleted ${countOf(files, "file")} and ${folderPart}`
    : `Deleted ${folderPart}`;
}

/**
 * What the page knows of the scan, from the last write that changed the
 * bucket or from the live route, whichever answered last.
 */
export interface ScanView {
  scheduled: ScanSchedule | null;
  running: boolean;
  clock: ServerClock;
}

/**
 * A write's schedule as the scan line reads it. Its two arms without a time
 * mean a pass is running: one more follows it, or it covers the change.
 */
export function viewOfWrite({ scan, clock }: WriteSchedule): ScanView {
  return { scheduled: scan, running: scan !== null && scan.scheduledAt === null, clock };
}

export function viewOfLive(live: LiveRead): ScanView {
  return { scheduled: live.scan.scheduled, running: live.scan.running, clock: live };
}

/** The later of two views, by when each answer arrived. */
export function latestView(...views: readonly (ScanView | undefined)[]): ScanView | undefined {
  return views.reduce<ScanView | undefined>(
    (latest, view) =>
      view !== undefined &&
      (latest === undefined || view.clock.receivedAt > latest.clock.receivedAt)
        ? view
        : latest,
    undefined,
  );
}

/** Whether a pass is scheduled or running: only then does the page read the live route. */
export function scanActive(view: ScanView | undefined): boolean {
  return view !== undefined && (view.scheduled !== null || view.running);
}

/** The scan line: a badge for its state and one sentence, or `null` while no pass is scheduled or running. */
export interface ScanLine {
  badge: "Scan scheduled" | "Scanning";
  text: string;
}

/**
 * The scan line's words by `now` (#83, "Layout", item 2), counted down on the
 * server's clock (`scheduleState`).
 */
export function scanLine(view: ScanView | undefined, now: number): ScanLine | null {
  if (view === undefined) {
    return null;
  }
  const state = scheduleState(view.scheduled, view.clock, now);
  switch (state?.state) {
    case "scheduled":
      return { badge: "Scan scheduled", text: `Library scan in ${aboutMinutes(state.minutes)}.` };
    case "starting":
      return { badge: "Scan scheduled", text: "Library scan starting." };
    case "after-current-pass":
      return {
        badge: "Scanning",
        text: "A scan is running. Another follows it for your recent changes.",
      };
    case "covered":
      return { badge: "Scanning", text: "A scan is running." };
    case undefined:
      return view.running ? { badge: "Scanning", text: "A scan is running." } : null;
  }
}
