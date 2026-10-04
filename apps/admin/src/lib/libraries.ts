import { type MutationOptions, type QueryClient, queryOptions } from "@tanstack/react-query";

import {
  ApiError,
  type ConnectionTest,
  fetchLibraries,
  type Library,
  type LibraryChanges,
  type LibraryList,
  type LibraryScan,
  type RemovedLibrary,
} from "@/lib/api";
import { describeConnectionFailure, describeError } from "@/lib/errors";
import type { FieldErrors } from "@/lib/field-errors";
import { filesConfigQuery } from "@/lib/files";
import { formatCount } from "@/lib/format";
import { libraryQuery } from "@/lib/overview";

/**
 * The rules of the Libraries page (`/libraries`, #84 "Console") that need no
 * screen: how often the list is read, which badges a library wears, the
 * bucket CORS rule, which refusal belongs to which field, and what the
 * dialogs and toasts say.
 */

/** The bound bucket: library 1, which cannot be removed and takes only a name and a default. */
export const DEFAULT_LIBRARY_ID = 1;

/** How long a read of the list stays fresh, and how often it is read while something moves. */
export const LIBRARIES_POLL_MS = 30_000;

/**
 * Whether a pass is in a library, or has yet to reach a new one: it entered
 * the library after it last left one (`lastScanStartedAt` after
 * `lastScanAt`), or the library has never been scanned. A library the last
 * pass skipped (`lastScanError`) waits for the next pass, which is no reason
 * to read the list sooner.
 */
export function scanPending(library: Library): boolean {
  if (library.state !== "active" || library.lastScanError !== null) {
    return false;
  }
  if (library.lastScanAt === null) {
    return true;
  }
  return (
    library.lastScanStartedAt !== null &&
    Date.parse(library.lastScanStartedAt) > Date.parse(library.lastScanAt)
  );
}

/**
 * The list's poll (#84): every 30 s while a pass runs or a library is being
 * removed, so its last scan, its counts and its removal show as they
 * happen, and not at all otherwise, since only the console and a pass
 * change the list.
 */
export function librariesRefetchInterval(list: LibraryList | undefined): number | false {
  const moving = list?.libraries.some(
    (library) => library.state === "removing" || scanPending(library),
  );
  return moving ? LIBRARIES_POLL_MS : false;
}

/**
 * The libraries, fresh for 30 s, read again after every library write
 * (`afterLibraryWrite`) and polled only while something moves. A hidden tab
 * reads nothing (`refetchIntervalInBackground: false`).
 */
export const librariesQuery = queryOptions({
  queryKey: ["libraries"],
  queryFn: fetchLibraries,
  staleTime: LIBRARIES_POLL_MS,
  refetchInterval: (query) => librariesRefetchInterval(query.state.data),
  refetchIntervalInBackground: false,
});

/** A state badge of a library's row, with the reason its tooltip gives, if any. */
export interface LibraryBadge {
  label: "Bound bucket" | "Removing" | "Read only" | "Scan failed";
  reason?: string;
}

/**
 * The badges a library's name wears: real states only (DESIGN.md). A
 * library being removed is only that, since nothing else about it matters
 * any more.
 */
export function libraryBadges(library: Library): LibraryBadge[] {
  if (library.state === "removing") {
    return [{ label: "Removing" }];
  }
  const badges: LibraryBadge[] = [];
  if (library.kind === "r2-binding") {
    badges.push({ label: "Bound bucket" });
  }
  if (!library.writable) {
    badges.push({ label: "Read only" });
  }
  if (library.lastScanError !== null) {
    badges.push({
      label: "Scan failed",
      reason: describeConnectionFailure(library.lastScanError).title,
    });
  }
  return badges;
}

/** Whether a library can be removed: any but the bound bucket, and not twice. */
export function removable(library: Library): boolean {
  return library.id !== DEFAULT_LIBRARY_ID && library.state === "active";
}

/** The file the CORS commands read. */
export const CORS_FILE = "r2-cors.json";

/**
 * The CORS rule a bucket needs for this console's uploads (#84, "CORS per
 * bucket"): Phase 2's `apps/server/r2-cors.example.json`, with the
 * console's origin. The browser `PUT`s each file straight to the bucket
 * with exactly the headers the URL was signed with, and reads its `ETag`.
 */
export function corsRule(origin: string) {
  return {
    rules: [
      {
        allowed: {
          origins: [origin],
          methods: ["PUT"],
          headers: ["content-type", "if-none-match"],
        },
        exposeHeaders: ["ETag"],
        maxAgeSeconds: 3600,
      },
    ],
  };
}

/**
 * The rule as the file `CORS_FILE` holds it, laid out as the example file
 * is: two-space indents, with each list of strings on one line.
 */
export function corsJson(origin: string): string {
  return JSON.stringify(corsRule(origin), null, 2).replace(
    /\[\n\s*("[^\]]*")\n\s*\]/g,
    (_list, items: string) => `[${items.split(/,\n\s*/).join(", ")}]`,
  );
}

/**
 * The Wrangler commands that apply the rule to `bucket` and show it, run
 * under the account that owns the bucket. A bound bucket whose name the
 * Worker does not know (`R2_BUCKET_NAME` unset) is written `<bucket>`.
 */
export function corsCommands(bucket: string | null): { set: string; list: string } {
  const name = bucket ?? "<bucket>";
  return {
    set: `pnpm exec wrangler r2 bucket cors set ${name} --file ${CORS_FILE}`,
    list: `pnpm exec wrangler r2 bucket cors list ${name}`,
  };
}

/** The connect and edit forms' fields, by `name`. */
export type LibraryField = "name" | "accountId" | "bucket" | "accessKeyId" | "secretAccessKey";

/**
 * The refusals that belong to a field of the connect and edit dialogs. A
 * refused key belongs to the pair, and shows beneath its second field.
 * Every other refusal (`invalid_request`, an unreachable bucket, …) is a
 * toast.
 */
export const LIBRARY_FIELDS_BY_CODE: Readonly<Record<string, LibraryField>> = {
  name_taken: "name",
  invalid_account_id: "accountId",
  invalid_bucket: "bucket",
  already_connected: "bucket",
};

export const LIBRARY_FIELDS_BY_REASON: Readonly<Record<string, LibraryField>> = {
  auth: "secretAccessKey",
  bucket_not_found: "bucket",
};

/** The field a refusal belongs to, or `undefined` for one that is a toast. */
export function libraryFieldOf(error: unknown): LibraryField | undefined {
  if (!(error instanceof ApiError)) {
    return undefined;
  }
  const byCode =
    error.code === "connection_failed" ? LIBRARY_FIELDS_BY_REASON : LIBRARY_FIELDS_BY_CODE;
  const key = error.code === "connection_failed" ? (error.reason ?? "") : error.code;
  return Object.hasOwn(byCode, key) ? byCode[key] : undefined;
}

/**
 * The field errors a refused library write reports, in the form whose
 * fields are `shown`: a refusal for a field the form does not show (a
 * stored key refused while editing only the bucket) is a toast instead.
 */
export function libraryFieldErrors(
  error: unknown,
  shown: readonly LibraryField[],
): FieldErrors | undefined {
  const field = libraryFieldOf(error);
  return field !== undefined && shown.includes(field)
    ? { [field]: `${describeError(error).title}.` }
    : undefined;
}

/** What the edit dialog holds when it is saved. */
export interface LibraryEdit {
  name: string;
  defaultNewUsers: boolean;
  accountId: string;
  bucket: string;
  replaceCredentials: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * What a PATCH sends: only what the edit dialog changed, or `null` when it
 * changed nothing. Library 1 takes its name and its default only. A new
 * token goes as both keys, or not at all.
 */
export function libraryChanges(library: Library, edited: LibraryEdit): LibraryChanges | null {
  const changes: LibraryChanges = {};
  // The server trims a name, so spaces around it change nothing.
  const name = edited.name.trim();
  if (name !== library.name) {
    changes.name = name;
  }
  if (edited.defaultNewUsers !== library.defaultNewUsers) {
    changes.defaultNewUsers = edited.defaultNewUsers;
  }
  if (library.kind !== "r2-binding") {
    const accountId = edited.accountId.trim();
    const bucket = edited.bucket.trim();
    if (accountId !== (library.accountId ?? "")) {
      changes.accountId = accountId;
    }
    if (bucket !== (library.bucket ?? "")) {
      changes.bucket = bucket;
    }
    if (edited.replaceCredentials) {
      changes.accessKeyId = edited.accessKeyId;
      changes.secretAccessKey = edited.secretAccessKey;
    }
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

/** Whether the edit moves a connected library to another account or bucket. */
export function bucketMoves(library: Library, edited: Pick<LibraryEdit, "accountId" | "bucket">) {
  if (library.kind === "r2-binding") {
    return false;
  }
  const accountId = edited.accountId.trim();
  const bucket = edited.bucket.trim();
  return (
    (accountId !== "" && accountId !== (library.accountId ?? "")) ||
    (bucket !== "" && bucket !== (library.bucket ?? ""))
  );
}

/** The note an edit that moves the library shows (#84). */
export const BUCKET_CHANGE_NOTE =
  "Tracks that are not in the new bucket leave the library at the next scan.";

/** `count` of `noun`, grouped, in the singular for one: `2,034 tracks`, `1 album`. */
export function countOf(count: number, noun: string): string {
  return `${formatCount(count)} ${count === 1 ? noun : `${noun}s`}`;
}

/**
 * What a removal takes with it, for its confirmation (#84, "Removing a
 * library"). The list counts tracks and albums; the playlists stored in the
 * bucket are counted only by the removal itself, so the toast names them.
 */
export function removeConsequences(library: Library): string {
  const { tracks, albums } = library.counts;
  return [
    `Its ${countOf(tracks, "track")}, ${countOf(albums, "album")} and the playlists stored in its bucket leave the library, with every star, rating, play count and bookmark on them.`,
    "The files in the bucket are not touched.",
    "Connecting the bucket again makes a new library, and none of this comes back.",
  ].join(" ");
}

/** A toast's words. `failed` raises the error toast. */
export interface LibraryNotice {
  title: string;
  description: string;
  failed?: boolean;
}

/** The toast of a connect (#84): the first scan, as the poke found the driver. */
export function connectedNotice(library: Library, scan: LibraryScan): LibraryNotice {
  const description =
    scan === "started"
      ? "Its first scan has started."
      : scan === "running"
        ? "The scan in progress includes it."
        : "The next scheduled scan indexes it.";
  return { title: `Connected ${library.name}`, description };
}

/** The toast of an edit: what it changed, in words. */
export function savedNotice(
  before: Library,
  after: Library,
  changes: LibraryChanges,
  scan: LibraryScan,
): LibraryNotice {
  const parts: string[] = [];
  if (after.name !== before.name) {
    parts.push(`Subsonic clients now show ${before.name} as ${after.name}.`);
  }
  if (after.accountId !== before.accountId || after.bucket !== before.bucket) {
    parts.push(
      scan === "started"
        ? `A scan of ${after.bucket ?? "the new bucket"} has started.`
        : `The next scan reads ${after.bucket ?? "the new bucket"}.`,
    );
  } else if (changes.accessKeyId !== undefined) {
    parts.push("Its new key is stored.");
  }
  if (after.defaultNewUsers !== before.defaultNewUsers) {
    parts.push(
      after.defaultNewUsers
        ? "New Subsonic users get access to it."
        : "New Subsonic users no longer get access to it.",
    );
  }
  return {
    title: `Saved ${after.name}`,
    description: parts.join(" ") || `${after.name} is saved.`,
  };
}

/** The toast of a connection test (#84): read and write, read only, or why it failed. */
export function testNotice(library: Library, result: ConnectionTest): LibraryNotice {
  if (!result.ok) {
    const failure = describeConnectionFailure(result.reason);
    const reason = failure.title.charAt(0).toLowerCase() + failure.title.slice(1);
    return { title: `${library.name}: ${reason}`, description: failure.description, failed: true };
  }
  if (!result.writable) {
    return {
      title: `${library.name}: connected, read only`,
      description:
        "The key lists the bucket but cannot write to it, so the Files page cannot change it.",
    };
  }
  if (library.kind === "r2-binding") {
    return {
      title: `${library.name}: connected, read and write`,
      description: result.uploads
        ? "The Worker reads the bucket, and uploads are configured."
        : "The Worker reads the bucket. Uploads need R2 API credentials on the server (see the server README).",
    };
  }
  return {
    title: `${library.name}: connected, read and write`,
    description: "The key lists the bucket and can write to it.",
  };
}

/** The toast of a removal, with what the server counted. */
export function removedNotice(library: Library, removed: RemovedLibrary): LibraryNotice {
  return {
    title: `Removed ${library.name}`,
    description: `Its ${countOf(removed.tracks, "track")}, ${countOf(removed.albums, "album")} and ${countOf(removed.playlists, "playlist")} leave the library as the scan cleans up. The files in the bucket are not touched.`,
  };
}

/**
 * After every library write, whether it went through or not: the list is
 * read again, so a refusal over a stale list shows the list as it is; the
 * Files page's configuration, which names the libraries, and the
 * Overview's library, whose totals a removal changes, are marked stale and
 * read again when they are on screen.
 */
export function afterLibraryWrite(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: librariesQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: filesConfigQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: libraryQuery.queryKey }),
  ]).then(() => undefined);
}

/** How a library write tells what it did: the page's toasts (lib/toasts.ts). */
export interface LibraryWriteNotices {
  success(title: string, description: string): void;
  failure(title: string, description: string): void;
  error(error: unknown): void;
}

/**
 * The options of a library write's mutation, as the Subsonic users page
 * makes its own (`userWriteOptions`): the toast and the re-read are the
 * mutation's, so they hold when the dialog closes mid-write, and a refusal
 * the dialog shows beside a field (`fieldShown`, asked once the re-read is
 * done) raises no toast.
 */
export function libraryWriteOptions<TData, TVariables>(
  queryClient: QueryClient,
  notices: LibraryWriteNotices,
  write: {
    mutationFn: (variables: TVariables) => Promise<TData>;
    succeeded: (data: TData, variables: TVariables) => LibraryNotice;
    fieldShown?: (error: unknown) => boolean;
  },
): MutationOptions<TData, unknown, TVariables> {
  return {
    mutationFn: write.mutationFn,
    onSuccess: (data, variables) => {
      const { title, description, failed } = write.succeeded(data, variables);
      (failed ? notices.failure : notices.success)(title, description);
    },
    onSettled: async (_data, error) => {
      await afterLibraryWrite(queryClient);
      if (error && !write.fieldShown?.(error)) {
        notices.error(error);
      }
    },
  };
}
