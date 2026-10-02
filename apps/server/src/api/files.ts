import type { Context } from "hono";
import { requireFreshSession, requirePermission, requireSession } from "../console-auth/middleware";
import { database } from "../db";
import type { Env } from "../env";
import {
  bucketName,
  fileWritesEnabled,
  requireFileWrites,
  type UploadsConfig,
  uploadsStatus,
} from "../files/config";
import {
  ALLOWED,
  checkBrowsePrefix,
  checkFolderPrefix,
  checkUploadKey,
  checkUploadSize,
  isReservedKey,
  kindOf,
  type ListedKind,
  MAX_KEY_BYTES,
  MAX_SEGMENT_BYTES,
  type PathRefusal,
  RESERVED_PREFIX,
  utf8Length,
} from "../files/keys";
import {
  RESCAN_QUIET_MS,
  recordLibraryChange,
  type ScanScheduleView,
} from "../files/library-change";
import { type PresignedUpload, presignUpload } from "../files/sign";
import { suffixOf } from "../library/audio-formats";
import { PLAYLIST_SUFFIXES } from "../playlists/m3u";
import { deletePlaylistRowsByKeys } from "../playlists/repository";
import { eraseObjects } from "../playlists/writes";
import type { ApiApp } from "./app";
import { invalidRequest, limitFileDeleteBody, limitJsonBody, readJsonObject } from "./json-body";
import { requireSameOrigin } from "./same-origin";

/**
 * The console's Files page (#83): the bound bucket, `MUSIC`, browsed one
 * folder at a time, files and folders deleted from it, and files uploaded to
 * it. An upload's bytes go from the browser straight to R2, with a URL this
 * API presigns (files/sign.ts), and never through the Worker.
 *
 * R2 has no folders: a folder is a common key prefix ending in `/`, as a
 * delimited listing reports it. Keys are used exactly as R2 lists them, never
 * normalised (files/keys.ts). The scanner's own `_covers/` prefix is hidden
 * from browse and refused to every write, `403 {"error":"reserved_path"}`.
 *
 * Reads need a session, which the cookie cache may vouch for, and
 * `files:read`. Writes go through `requireSameOrigin`, a body cap,
 * `requireFreshSession` (D1, past the cookie cache), `files:write` and
 * `requireFileWrites` (files/config.ts), in that order; each sends a JSON
 * object. The answers:
 *
 * - `GET /api/files/config`: `200 FilesConfig`, the bucket's name, whether
 *   uploads are configured, the allow-list, the limits, the quiet window and
 *   whether writes are enabled.
 * - `GET /api/files?prefix=&cursor=`: `200 {prefix, folders, files, cursor}`;
 *   `400 invalid_path`, `403 reserved_path`.
 * - `POST /api/files/delete`, `{keys}`, 1–250 keys:
 *   `200 {deleted, scan}`; `400 invalid_request`, `403 reserved_path`.
 * - `POST /api/files/delete-folder`, `{prefix}`:
 *   `200 {deleted, done, scan}`, called again until `done`;
 *   `400 invalid_path`, `403 reserved_path`.
 * - `POST /api/files/uploads`, `{files: [{key, size, overwrite?}]}`, 1–20
 *   files: `200 {uploads}`, one result per file, in order, each a presigned
 *   `PUT` or a per-file `error`; `400 invalid_request`,
 *   `503 uploads_not_configured`.
 * - `POST /api/files/uploads/complete`, `{keys}`, 1–20 keys whose `PUT`
 *   succeeded: `200 {scan}`; `400 invalid_request`, `403 reserved_path`.
 * - Any write, where `FILE_WRITES` is `"off"`: `403 file_writes_disabled`.
 *
 * ## Deletes are permanent
 *
 * Owner decision 1: there is no trash, no copy and no undo. A delete removes
 * the objects, and nothing is written anywhere in their place.
 *
 * ## Deletes and the library
 *
 * Tracks leave the library through the scan, as they do today: the pass
 * removes a track whose object is gone, then recomputes and prunes its album,
 * its artists and their covers. A delete therefore removes only the objects
 * and records the change (files/library-change.ts), which schedules that
 * pass. Playlists leave at once, as `deletePlaylist` makes them leave
 * (ADR-0006): the rows of every deleted key with a playlist suffix are
 * deleted right after the objects, in one round trip.
 *
 * `scan` is what the driver will do about the change, or null when it could
 * not be told, or when nothing was deleted.
 *
 * ## Uploads
 *
 * An upload is signed just before the browser sends it, and reported once R2
 * has taken it:
 *
 * 1. `POST /api/files/uploads` checks each file against the upload rules
 *    (files/keys.ts), asks R2 whether its key exists, and presigns a `PUT`
 *    bound to the key, the exact size and the content type. A new key is
 *    signed with `If-None-Match: *`, so R2 refuses it if it appears in the
 *    meantime. An existing key answers `exists`, with its size and time,
 *    unless the request says `overwrite: true` (Replace): then the URL is
 *    signed for the key exactly as R2 stores it, which may be another
 *    Unicode spelling of the one asked for, and without `If-None-Match`, so
 *    the track's id and annotations are kept (ADR-0002). Nothing has changed
 *    yet, so the library is not marked changed.
 * 2. `POST /api/files/uploads/complete` reports the keys whose `PUT`
 *    succeeded, and records the change as a delete does. It makes no R2 call:
 *    the keys are bounded by the upload rules, and a key that was not really
 *    uploaded only causes a pass that finds nothing new.
 */

/**
 * The most files one `POST /api/files/uploads` signs, and the most keys one
 * `POST /api/files/uploads/complete` reports: 20 presigns keep the request
 * well inside its 10 ms of CPU.
 */
export const SIGN_BATCH = 20;

/** The most `head()` calls in flight at once: a Worker waits on six connections at a time. */
export const HEADS_IN_FLIGHT = 6;

/** The most keys one `POST /api/files/delete` takes; the body cap is sized for it. */
export const DELETE_BATCH = 250;

/** The most entries one browse page lists: R2's own most. */
const BROWSE_PAGE = 1000;

/** The most keys one listing of a folder delete reaches: R2's own most. */
const FOLDER_DELETE_PAGE = 1000;

/**
 * The listings one `delete-folder` request makes at most: 2,000 keys, which
 * keeps the request inside its 10 ms of CPU and far inside the subrequests.
 */
const FOLDER_DELETE_PAGES = 2;

/** A folder of the folder browsed. */
export interface FolderView {
  readonly name: string;
  readonly prefix: string;
}

/** A file of the folder browsed. */
export interface FileView {
  readonly name: string;
  readonly key: string;
  readonly size: number;
  /** R2's `uploaded`, the only timestamp an object has. */
  readonly uploadedAt: string;
  readonly kind: ListedKind;
}

export function registerFileRoutes(api: ApiApp): void {
  const write = [requireFreshSession, requirePermission("files:write"), requireFileWrites] as const;

  /**
   * `GET /api/files/config`: what the console needs to know once a session,
   * with no binding call and no D1 statement.
   */
  api.get("/files/config", requireSession, requirePermission("files:read"), (c) =>
    c.json({
      allowed: ALLOWED,
      // R2_BUCKET_NAME, or null when unset.
      bucket: bucketName(c.env),
      // Whether uploads can be signed here; `missing` names the values that
      // are not set, never their contents.
      uploads: uploadsView(c.env),
      limits: {
        maxKeyBytes: MAX_KEY_BYTES,
        maxSegmentBytes: MAX_SEGMENT_BYTES,
        signBatch: SIGN_BATCH,
        deleteBatch: DELETE_BATCH,
      },
      rescanQuietSeconds: RESCAN_QUIET_MS / 1000,
      // Whether the write routes are open here: false where `FILE_WRITES` is
      // "off", the preview environment, and the console hides their controls.
      writes: { enabled: fileWritesEnabled(c.env) },
    }),
  );

  /**
   * `GET /api/files`: one page of one folder, in one binding call, folders
   * first and each in R2's order (lexicographic by key). `prefix` is the
   * root when missing; `cursor` is R2's, null on the last page.
   */
  api.get("/files", requireSession, requirePermission("files:read"), async (c) => {
    const prefix = c.req.query("prefix") ?? "";
    const refusal = checkBrowsePrefix(prefix);
    if (refusal !== null) {
      return refused(c, refusal);
    }

    const listing = await c.env.MUSIC.list({
      prefix,
      delimiter: "/",
      limit: BROWSE_PAGE,
      cursor: c.req.query("cursor") || undefined,
    });

    const folders: FolderView[] = listing.delimitedPrefixes
      // `_covers/` is the scanner's, and only ever at the root.
      .filter((folder) => folder !== RESERVED_PREFIX)
      .map((folder) => ({ name: folder.slice(prefix.length, -1), prefix: folder }));
    const files: FileView[] = listing.objects
      // An object named like the folder itself is a "folder marker" some S3
      // tools write: the folder, not a file in it.
      .filter((object) => object.key !== prefix)
      .map((object) => ({
        name: object.key.slice(prefix.length),
        key: object.key,
        size: object.size,
        uploadedAt: object.uploaded.toISOString(),
        kind: kindOf(object.key),
      }));

    return c.json({
      prefix,
      folders,
      files,
      cursor: listing.truncated ? listing.cursor : null,
    });
  });

  /**
   * `POST /api/files/delete` with `{keys}`: 1–250 keys, exactly as browse
   * listed them, deleted in one binding call. A key that is not there is not
   * an error, so `deleted` counts the distinct keys given.
   */
  api.post("/files/delete", requireSameOrigin, limitFileDeleteBody, ...write, async (c) => {
    const { keys } = (await readJsonObject(c)) ?? {};
    if (!isKeyList(keys)) {
      return invalidRequest(c);
    }
    if (keys.some(isReservedKey)) {
      // The whole request, before any object is touched.
      return refused(c, "reserved_path");
    }

    const distinct = [...new Set(keys)];
    await eraseObjects(c.env, distinct);
    const scan = await afterDelete(c.env, distinct);

    return c.json({ deleted: distinct.length, scan });
  });

  /**
   * `POST /api/files/delete-folder` with `{prefix}`: every key under the
   * prefix, at any depth, at most `FOLDER_DELETE_PAGES` listings of
   * `FOLDER_DELETE_PAGE` keys a request. `done` is true once a listing comes
   * back complete; until then the console calls again.
   *
   * Each listing starts from the beginning of the prefix, since the keys the
   * one before it found are gone, so the request needs no cursor. A file
   * uploaded into the folder while it is being deleted is deleted too, which
   * is what was asked.
   */
  api.post("/files/delete-folder", requireSameOrigin, limitJsonBody, ...write, async (c) => {
    const { prefix } = (await readJsonObject(c)) ?? {};
    if (typeof prefix !== "string") {
      return invalidRequest(c);
    }
    const refusal = checkFolderPrefix(prefix);
    if (refusal !== null) {
      return refused(c, refusal);
    }

    const deleted: string[] = [];
    let done = false;
    for (let page = 0; page < FOLDER_DELETE_PAGES && !done; page++) {
      const listing = await c.env.MUSIC.list({ prefix, limit: FOLDER_DELETE_PAGE });
      const keys = listing.objects.map((object) => object.key);
      await eraseObjects(c.env, keys);
      deleted.push(...keys);
      done = !listing.truncated;
    }

    const scan = deleted.length === 0 ? null : await afterDelete(c.env, deleted);

    return c.json({ deleted: deleted.length, done, scan });
  });

  /**
   * `POST /api/files/uploads` with `{files}`: 1–20 files to sign, each
   * `{key, size, overwrite?}`. A refused file does not fail the others: the
   * request answers 200 with one result per file, in order.
   */
  api.post("/files/uploads", requireSameOrigin, limitJsonBody, ...write, async (c) => {
    const status = uploadsStatus(c.env);
    if (!status.configured) {
      return c.json({ error: "uploads_not_configured" }, 503);
    }

    const { files } = (await readJsonObject(c)) ?? {};
    const requested = readUploadRequests(files);
    if (requested === null) {
      return invalidRequest(c);
    }

    // One instant for the whole batch: every URL expires together.
    const now = Date.now();
    const uploads = await mapInFlight(requested, HEADS_IN_FLIGHT, (file) =>
      signUpload(c.env, status.config, file, now),
    );

    return c.json({ uploads });
  });

  /**
   * `POST /api/files/uploads/complete` with `{keys}`: 1–20 keys whose `PUT`
   * R2 accepted. It records the change, in one D1 statement and one call to
   * the scan driver, and answers what the driver will do about it.
   */
  api.post("/files/uploads/complete", requireSameOrigin, limitJsonBody, ...write, async (c) => {
    const { keys } = (await readJsonObject(c)) ?? {};
    if (!isCompletedKeyList(keys)) {
      return invalidRequest(c);
    }
    const refusals = keys.map(checkUploadKey).flatMap((key) => ("error" in key ? [key.error] : []));
    if (refusals.includes("reserved_path")) {
      return refused(c, "reserved_path");
    }
    if (refusals.length > 0) {
      // Not a key an upload could have written.
      return invalidRequest(c);
    }

    const scan = await recordLibraryChange(c.env, database(c.env), Date.now());

    return c.json({ scan });
  });
}

/** One file `POST /api/files/uploads` is asked to sign. */
interface UploadRequest {
  readonly key: string;
  readonly size: number;
  readonly overwrite: boolean;
}

/** Why one file is not signed. */
export type UploadRefusal = PathRefusal | "empty_file" | "too_large";

/** One result of `POST /api/files/uploads`, in the order the files were asked for. */
export type UploadResult =
  | ({ readonly key: string } & PresignedUpload)
  | { readonly key: string; readonly error: UploadRefusal }
  | {
      readonly key: string;
      readonly error: "exists";
      readonly existing: { readonly size: number; readonly uploadedAt: string };
    };

/** `uploads` of `GET /api/files/config`. */
function uploadsView(env: Env) {
  const status = uploadsStatus(env);
  return status.configured
    ? { configured: true as const }
    : { configured: false as const, missing: status.missing };
}

/**
 * The files of a sign request, or null unless it is 1–20 objects, each with a
 * string `key`, a `size` that is a whole number of bytes, and an `overwrite`
 * that is a boolean when given.
 */
function readUploadRequests(files: unknown): UploadRequest[] | null {
  if (!Array.isArray(files) || files.length < 1 || files.length > SIGN_BATCH) {
    return null;
  }

  const requested: UploadRequest[] = [];
  for (const file of files) {
    if (typeof file !== "object" || file === null || Array.isArray(file)) {
      return null;
    }
    const { key, size, overwrite } = file as Record<string, unknown>;
    if (
      typeof key !== "string" ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      (overwrite !== undefined && typeof overwrite !== "boolean")
    ) {
      return null;
    }
    requested.push({ key, size, overwrite: overwrite === true });
  }

  return requested;
}

/**
 * One file's result: why it is refused, that its key exists, or its
 * presigned `PUT`. Its key is the one asked for in NFC, or on Replace the
 * key exactly as R2 stores it.
 */
async function signUpload(
  env: Env,
  config: UploadsConfig,
  file: UploadRequest,
  now: number,
): Promise<UploadResult> {
  const checked = checkUploadKey(file.key);
  if ("error" in checked) {
    return { key: file.key.normalize("NFC"), error: checked.error };
  }
  const sizeRefusal = checkUploadSize(checked.kind, file.size);
  if (sizeRefusal !== null) {
    return { key: checked.key, error: sizeRefusal };
  }

  // One Class B operation. R2 treats NFC-equivalent keys as one object, so
  // this finds an object stored under another spelling too.
  const stored = await env.MUSIC.head(checked.key);
  if (stored !== null && !file.overwrite) {
    return {
      key: checked.key,
      error: "exists",
      existing: { size: stored.size, uploadedAt: stored.uploaded.toISOString() },
    };
  }

  const key = stored?.key ?? checked.key;
  const presigned = await presignUpload(
    config,
    { key, size: file.size, contentType: checked.contentType, replace: stored !== null },
    now,
  );

  return { key, ...presigned };
}

/**
 * `work` applied to every item, at most `limit` at a time, with the results
 * in the items' order.
 */
async function mapInFlight<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));

  return results;
}

/** Whether `keys` is 1–20 strings, as a complete request reports them. */
function isCompletedKeyList(keys: unknown): keys is string[] {
  return (
    Array.isArray(keys) &&
    keys.length >= 1 &&
    keys.length <= SIGN_BATCH &&
    keys.every((key) => typeof key === "string")
  );
}

/**
 * What follows the deletion of these objects: the rows of the playlists they
 * were, then the record of the change, which schedules the pass that takes
 * the deleted tracks out of the library.
 */
async function afterDelete(env: Env, keys: readonly string[]): Promise<ScanScheduleView | null> {
  const db = database(env);
  const playlistKeys = keys.filter((key) => PLAYLIST_SUFFIXES.includes(suffixOf(key)));
  await deletePlaylistRowsByKeys(db, playlistKeys);

  return recordLibraryChange(env, db, Date.now());
}

/** Whether `keys` is 1–250 keys, each a non-empty string of at most 1,024 bytes. */
function isKeyList(keys: unknown): keys is string[] {
  return (
    Array.isArray(keys) &&
    keys.length >= 1 &&
    keys.length <= DELETE_BATCH &&
    keys.every((key) => typeof key === "string" && key !== "" && utf8Length(key) <= MAX_KEY_BYTES)
  );
}

function refused(c: Context, error: "invalid_path" | "reserved_path") {
  return error === "invalid_path" ? c.json({ error }, 400) : c.json({ error }, 403);
}
