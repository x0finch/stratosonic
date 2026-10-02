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
  type FolderListing,
  fetchFiles,
  fetchFilesConfig,
  type ScanSchedule,
  type ServerClock,
} from "@/lib/api";
import { formatCount } from "@/lib/format";
import { aboutMinutes, type LiveRead, scheduleState } from "@/lib/overview";

/**
 * The Files page's rules that need no screen (#83, "Console"): how it reads
 * the bucket, the folder path, the New folder name check, how a delete is
 * split into requests and what it says, and the scan line.
 *
 * ## Reads
 *
 * | Query | `staleTime` | Read again |
 * |---|---|---|
 * | `/api/files/config` | `Infinity` | never: once a session |
 * | `/api/files?prefix=` | 30 s | on Load more, and after every delete (its first page only) |
 * | `/api/overview/live` | 0, as the Overview's | only while a scan is scheduled or running, with `library:read` |
 *
 * Nothing is polled while no scan is scheduled or running, and a hidden tab
 * reads nothing (`refetchIntervalInBackground: false`, the live query's own).
 */

/** How long a folder's listing stays fresh: only the console, a pass's covers and rclone change it. */
export const FOLDER_STALE_MS = 30_000;

/** The bucket's name when the server does not say it (`bucket` comes with ticket C). */
export const BUCKET_FALLBACK = "Bucket";

export const filesConfigQuery = queryOptions({
  queryKey: ["files", "config"],
  queryFn: fetchFilesConfig,
  staleTime: Number.POSITIVE_INFINITY,
});

/** Every folder listing in the cache, whatever its prefix. */
const FOLDERS_KEY = ["files", "folder"] as const;

/**
 * One folder, a page of 1,000 entries at a time: Load more reads the next
 * page with R2's cursor while there is one. R2 gives no total.
 */
export function folderQuery(prefix: string) {
  return infiniteQueryOptions({
    queryKey: [...FOLDERS_KEY, prefix],
    queryFn: ({ pageParam }) => fetchFiles(prefix, pageParam),
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
 * After a delete: every folder read so far is out of date (a folder deleted
 * from its parent took its subfolders with it), so each is cut back to its
 * first page and marked stale, and the folder on screen is read again at
 * once, in one request whatever pages were loaded.
 */
export function afterFilesChange(queryClient: QueryClient): Promise<void> {
  queryClient.setQueriesData<InfiniteData<FolderListing, string | null>>(
    { queryKey: FOLDERS_KEY },
    firstPage,
  );
  return queryClient.invalidateQueries({ queryKey: FOLDERS_KEY });
}

/**
 * A cursor R2 refused (`invalid_cursor`): the folder is opened again from its
 * first page.
 */
export function reopenFolder(queryClient: QueryClient, prefix: string): Promise<void> {
  const { queryKey } = folderQuery(prefix);
  queryClient.setQueryData(queryKey, firstPage);
  return queryClient.refetchQueries({ queryKey, exact: true });
}

/**
 * The `?prefix=` search parameter of `/files`: a folder's prefix, ending in
 * `/`, or absent for the root. A deep link that names a folder without its
 * final slash gets it; anything that is not a string opens the root.
 */
export function validateFilesSearch(search: Record<string, unknown>): { prefix?: string } {
  const { prefix } = search;
  if (typeof prefix !== "string" || prefix === "") {
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

/** A folder's own name, or the bucket's at the root. */
export function folderTitle(prefix: string, bucket: string): string {
  return folderTrail(prefix).at(-1)?.name ?? bucket;
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
const FORBIDDEN_CHARACTERS = /[\u0000-\u001f\u007f\\]/;

/** The length of a string in bytes of UTF-8, as R2 counts a key. */
function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Checks a New folder name against the server's rules for a new key's segment
 * (apps/server `files/keys.ts`), and answers the folder's prefix, or why the
 * name is refused, in words for beside the field. The name is trimmed and
 * written in NFC, as every new key is. Nothing is written: R2 has no folders,
 * so the folder exists once a file lands in it.
 */
export function checkFolderName(
  raw: string,
  prefix: string,
  limits: Pick<FilesConfig["limits"], "maxKeyBytes" | "maxSegmentBytes">,
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
  if (folder === "_covers/") {
    return { error: "_covers is the scanner's own folder." };
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
  const outcome: DeleteOutcome = { files: 0, folders: [], schedule: undefined };
  try {
    for (const keys of plan.fileBatches) {
      const result = await calls.deleteFiles(keys);
      outcome.files += result.deleted;
      outcome.schedule = { scan: result.scan, clock: result.clock };
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
