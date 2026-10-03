import type { Context } from "hono";
import { requireFreshSession, requirePermission, requireSession } from "../console-auth/middleware";
import { database } from "../db";
import type { Env } from "../env";
import { CHECK_BATCH, type ExistingKey, groupCheckKeys, matchListing } from "../files/check";
import { bucketName, fileWritesEnabled, requireFileWrites, uploadsStatus } from "../files/config";
import {
  ALLOWED,
  checkBrowsePrefix,
  checkFolderPrefix,
  checkUploadKey,
  checkUploadPrefix,
  checkUploadSize,
  hasOneSpelling,
  isAscii,
  isReservedKey,
  MAX_KEY_BYTES,
  MAX_SEGMENT_BYTES,
  newKeySpelling,
  oneSpellingPrefix,
  type PathRefusal,
  utf8Length,
} from "../files/keys";
import { RESCAN_QUIET_MS, recordLibraryChange, type ScanSchedule } from "../files/library-change";
import { folderListing, playlistKeysOf } from "../files/listing";
import type { PresignedUpload } from "../files/sign";
import { deletePlaylistRowsByKeys } from "../playlists/repository";
import { bindingStorage } from "../storage/binding";
import type { LibraryStorage, StorageListing } from "../storage/storage";
import type { ApiApp } from "./app";
import {
  invalidRequest,
  limitFileCheckBody,
  limitFileDeleteBody,
  limitJsonBody,
  readJsonObject,
} from "./json-body";
import { requireSameOrigin } from "./same-origin";

/**
 * The console's Files page (#83): the bound bucket, `MUSIC`, browsed one
 * folder at a time, files and folders deleted from it, and files uploaded to
 * it, all through its storage (storage/binding.ts). An upload's bytes go from
 * the browser straight to R2, with a URL the storage presigns
 * (`presignPut`, files/sign.ts), and never through the Worker.
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
 *   `400 invalid_path`, `403 reserved_path`, `400 invalid_cursor` (a cursor
 *   R2 refuses: forged, stale or from another prefix).
 * - `POST /api/files/delete`, `{keys}`, 1–250 keys:
 *   `200 {deleted, scan}`; `400 invalid_request`, `403 reserved_path`.
 * - `POST /api/files/delete-folder`, `{prefix}`:
 *   `200 {deleted, done, scan}`, called again until `done`, or
 *   `200 {deleted: 0, done: true}`, with no `scan`, when there was nothing
 *   left to delete; `400 invalid_path`, `403 reserved_path`.
 * - `POST /api/files/uploads`, `{prefix?, files: [{key, size, overwrite?}]}`,
 *   1–10 files: `200 {uploads}`, one result per file, in order, each a presigned
 *   `PUT` or a per-file `error` (`invalid_path`, `path_too_long`,
 *   `reserved_path`, `type_not_allowed`, `too_large`, `empty_file`,
 *   `exists`, or `replace_unavailable`: replace that file with rclone);
 *   `400 invalid_request`, `503 uploads_not_configured`. `prefix` is the
 *   folder uploaded into, exactly as browse listed it: it is kept as it is,
 *   and only the part of each key after it is normalised to NFC; a key
 *   outside it answers `invalid_path` for that file, and a bad prefix
 *   `400 invalid_path` or `403 reserved_path` for the request.
 * - `POST /api/files/uploads/check`, `{prefix?, keys}`, 1–500 keys about
 *   to be uploaded: `200 {existing: [{key, storedKey, size, uploadedAt}],
 *   unchecked: [key]}`; `400 invalid_request`, and for a bad prefix
 *   `400 invalid_path` or `403 reserved_path`. It needs no upload
 *   configuration: it reads the binding.
 * - `POST /api/files/uploads/complete`, `{keys}`, 1–10 keys whose `PUT`
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
 * ## `scan`
 *
 * Every answer that deleted something, and every upload completion, carries
 * `scan`, what the driver will do about the change (`ScanSchedule`,
 * files/library-change.ts):
 *
 * - `{"scheduledAt": "<ISO 8601>", "afterCurrentPass": false}`: a pass
 *   starts at about that time, once the library has stayed quiet;
 * - `{"scheduledAt": null, "afterCurrentPass": true}`: a pass is running,
 *   and one more follows it for the change;
 * - `{"scheduledAt": null, "afterCurrentPass": false}`: the pass in flight
 *   began after the change and covers it, so no other pass is needed;
 * - `null`: the change is recorded, but the driver could not be told. The
 *   next cron pass (at most 15 minutes away) indexes it.
 *
 * `null` has that one meaning. A delete-folder round that deleted nothing
 * changed nothing, so it records no change and carries no `scan` at all.
 *
 * ## A folder delete that fails half way
 *
 * A delete-folder round whose second listing or delete fails after the
 * first page went still does what follows a delete for the keys already
 * gone (their playlists' rows, then the change record), and then answers
 * 500. The console retries the round, which lists the folder again from its
 * start.
 *
 * ## Uploads
 *
 * A pick is checked first, an upload is signed just before the browser sends
 * it, and reported once R2 has taken it:
 *
 * 0. `POST /api/files/uploads/check` (#141) says which of a pick's keys
 *    already exist, before anything is signed, so the console asks once
 *    whether to replace or skip them. Each key that passes the upload rules
 *    (an invalid one is simply not reported) is grouped by its folder,
 *    exactly as given; each folder is listed with a delimiter, page after
 *    page, and the names compared in NFC, since the stored spelling may
 *    differ. At most `CHECK_LISTINGS` (40) listings a request, and
 *    `CHECK_ENTRIES` (2,000) entries listed in all, as much as one
 *    `delete-folder` round. A key whose folder was not listed to its end
 *    (a large flat folder, or one past the budget) is then looked for with
 *    one `head()` (Class B), as many as the request's `CHECK_CALLS` (47)
 *    binding calls leave room for: at least 7. A key still unknown is
 *    answered in `unchecked`, never as new, and the console asks again for
 *    those, each request with a fresh budget. A folder stored in another
 *    spelling than the one given lists nothing, so its keys read as new;
 *    the `PUT`'s `If-None-Match: *` still refuses them. Its cost: one
 *    `ListObjects` (Class A) per page and one `HeadObject` (Class B) per
 *    key looked up, no D1 statement past the session check's, no driver
 *    call: 47 binding calls + at most 3 D1 statements = 50 subrequests
 *    (`requireFreshSession` reads the session and its user, and updates
 *    the session once it is past `updateAge`). At most `CHECK_BATCH` (500) keys a
 *    request: checking them against the upload rules is most of its CPU.
 * 1. `POST /api/files/uploads` checks each file against the upload rules
 *    (files/keys.ts), asks R2 whether its key exists, and presigns a `PUT`
 *    bound to the key, the exact size and the content type. A new key is
 *    signed with `If-None-Match: *`, so R2 refuses it if it appears in the
 *    meantime. An existing key answers `exists`, with its size and time,
 *    unless the request says `overwrite: true` (Replace): then the URL is
 *    signed for the key exactly as R2 lists it, which may be another
 *    Unicode spelling of the one asked for (`storedSpelling`), and without
 *    `If-None-Match`, so the track's id and annotations are kept
 *    (ADR-0002). If that spelling cannot be found for certain, the file
 *    answers `replace_unavailable` rather than risk another spelling: the
 *    owner replaces it with rclone. Nothing has changed yet, so the library
 *    is not marked changed.
 *
 *    Its cost: one `HeadObject` (Class B) per file that passes the rules,
 *    and, for a Replace of an existing key with more than one possible
 *    spelling, one `ListObjects` (Class A) per page listed to find it, at
 *    most `SPELLING_LISTINGS` (3) a file. So a request of 10 files makes at
 *    most 10 + 30 = 40 binding calls, and with the session check's D1
 *    statements (at most 2) at most 42 subrequests, inside the 50.
 * 2. `POST /api/files/uploads/complete` reports the keys whose `PUT`
 *    succeeded, and records the change as a delete does. It makes no R2 call:
 *    the keys are bounded by the upload rules, and a key that was not really
 *    uploaded only causes a pass that finds nothing new.
 */

/**
 * The most files one `POST /api/files/uploads` signs, and the most keys one
 * `POST /api/files/uploads/complete` reports. Each presign is about 0.3 ms of
 * CPU (bench-file-uploads.ts, in Node), so 10 keep a request near 5 ms,
 * well inside its 10 ms; 20 measured about 8.4 ms, too close. The console
 * signs at most 3 at a time anyway.
 */
export const SIGN_BATCH = 10;

/** The most `head()` calls in flight at once: a Worker waits on six connections at a time. */
export const HEADS_IN_FLIGHT = 6;

/** The keys one listing that looks for a Replace's stored spelling reaches: R2's own most. */
const SPELLING_PAGE = 1000;

/** The pages listed for one segment of a Replace's key: 2,000 entries of one folder. */
const SPELLING_PAGES_PER_SEGMENT = 2;

/**
 * The listings one Replace may make to find its stored spelling, across
 * every segment. With `SIGN_BATCH` and one `head()` a file, it bounds a
 * request's binding calls at 40.
 */
export const SPELLING_LISTINGS = 3;

/** The most keys one `POST /api/files/uploads/check` takes (files/check.ts). */
export { CHECK_BATCH } from "../files/check";

/**
 * The most binding calls one upload check makes, listings and `head()`s
 * together: 47 binding calls + at most 3 D1 statements = 50 subrequests.
 * The session check (`requireFreshSession`) reads the session and its
 * user, and updates the session once it is past Better Auth's `updateAge`
 * (test/console-auth-sessions.test.ts).
 */
export const CHECK_CALLS = 47;

/** The most of those calls that are listings: the rest are left for `head()`s. */
export const CHECK_LISTINGS = 40;

/**
 * The most entries (objects and subfolders) one upload check lists, across
 * its listings: two of R2's pages, what one `delete-folder` round reaches
 * (`FOLDER_DELETE_PAGES`), so a request stays as far inside its 10 ms of
 * CPU. Each listing asks for no more than is left, so the bound is exact.
 * The keys of a folder of more entries are looked for one `head()` each.
 */
export const CHECK_ENTRIES = 2000;

/** The keys one listing of an upload check reaches at most: R2's own most. */
const CHECK_PAGE = 1000;

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
   * `GET /api/files`: one page of one folder, in one binding call
   * (`folderListing`). `prefix` is the root when missing; `cursor` is R2's,
   * null on the last page.
   *
   * A listing R2 refuses while carrying a cursor answers
   * `400 {"error":"invalid_cursor"}`: the cursor came from the client, and R2
   * is what decides it is not one of its own. The console's answer is the
   * same either way, to open the folder again from its first page. Without a
   * cursor, a failed listing is the 500 it is.
   */
  api.get("/files", requireSession, requirePermission("files:read"), async (c) => {
    const prefix = c.req.query("prefix") ?? "";
    const refusal = checkBrowsePrefix(prefix);
    if (refusal !== null) {
      return refused(c, refusal);
    }

    const cursor = c.req.query("cursor") || undefined;
    let listing: StorageListing;
    try {
      listing = await bindingStorage(c.env).list({
        prefix,
        delimiter: "/",
        limit: BROWSE_PAGE,
        cursor,
      });
    } catch (error) {
      if (cursor === undefined) {
        throw error;
      }
      console.warn("files: R2 refused a listing's cursor", error);
      return c.json({ error: "invalid_cursor" }, 400);
    }

    return c.json(folderListing(prefix, listing));
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
    await bindingStorage(c.env).delete(distinct);
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

    const storage = bindingStorage(c.env);
    // The keys of every delete call that succeeded.
    const deleted: string[] = [];
    let done = false;
    let completed = false;
    try {
      for (let page = 0; page < FOLDER_DELETE_PAGES && !done; page++) {
        const listing = await storage.list({ prefix, limit: FOLDER_DELETE_PAGE });
        const keys = listing.objects.map((object) => object.key);
        await storage.delete(keys);
        deleted.push(...keys);
        done = listing.cursor === null;
      }
      completed = true;
    } finally {
      // A round that failed half way still accounts for what it deleted, and
      // the error then goes on to the 500 handler. A failure of that work is
      // logged rather than hiding the first one.
      if (!completed && deleted.length > 0) {
        await afterDelete(c.env, deleted).catch((error: unknown) => {
          console.error("files: recording a half-done folder delete failed", error);
        });
      }
    }

    if (deleted.length === 0) {
      return c.json({ deleted: 0, done });
    }

    const scan = await afterDelete(c.env, deleted);
    return c.json({ deleted: deleted.length, done, scan });
  });

  /**
   * `POST /api/files/uploads` with `{prefix?, files}`: 1–10 files to sign,
   * each `{key, size, overwrite?}`, in the folder `prefix` (as listed, never
   * normalised) when given. A refused file does not fail the others: the
   * request answers 200 with one result per file, in order.
   */
  api.post("/files/uploads", requireSameOrigin, limitJsonBody, ...write, async (c) => {
    const status = uploadsStatus(c.env);
    if (!status.configured) {
      return c.json({ error: "uploads_not_configured" }, 503);
    }

    const { prefix = "", files } = (await readJsonObject(c)) ?? {};
    const requested = readUploadRequests(files);
    if (requested === null || typeof prefix !== "string") {
      return invalidRequest(c);
    }
    const prefixRefusal = checkUploadPrefix(prefix);
    if (prefixRefusal !== null) {
      return refused(c, prefixRefusal);
    }

    // One instant for the whole batch: every URL expires together.
    const now = Date.now();
    const storage = bindingStorage(c.env);
    const uploads = await mapInFlight(requested, HEADS_IN_FLIGHT, (file) =>
      signUpload(storage, prefix, file, now),
    );

    return c.json({ uploads });
  });

  /**
   * `POST /api/files/uploads/check` with `{prefix?, keys}`: which of 1–500
   * keys already exist, as the console asks before a pick is signed (see
   * "Uploads", step 0). It reads only the binding, so it works where uploads
   * are not configured.
   */
  api.post("/files/uploads/check", requireSameOrigin, limitFileCheckBody, ...write, async (c) => {
    const { prefix = "", keys } = (await readJsonObject(c)) ?? {};
    if (!isCheckKeyList(keys) || typeof prefix !== "string") {
      return invalidRequest(c);
    }
    const prefixRefusal = checkUploadPrefix(prefix);
    if (prefixRefusal !== null) {
      return refused(c, prefixRefusal);
    }

    return c.json(await checkExisting(bindingStorage(c.env), prefix, keys));
  });

  /**
   * `POST /api/files/uploads/complete` with `{keys}`: 1–10 keys whose `PUT`
   * R2 accepted. It records the change, in one D1 statement and one call to
   * the scan driver, and answers what the driver will do about it.
   */
  api.post("/files/uploads/complete", requireSameOrigin, limitJsonBody, ...write, async (c) => {
    const { keys } = (await readJsonObject(c)) ?? {};
    if (!isCompletedKeyList(keys)) {
      return invalidRequest(c);
    }
    const refusals = keys
      .map((key) => checkUploadKey(key))
      .flatMap((key) => ("error" in key ? [key.error] : []));
    if (refusals.includes("reserved_path")) {
      return refused(c, "reserved_path");
    }
    if (refusals.length > 0) {
      // Not a key an upload could have written.
      return invalidRequest(c);
    }

    const scan = await recordLibraryChange(c.env, Date.now());

    return c.json({ scan });
  });
}

/** One file `POST /api/files/uploads` is asked to sign. */
interface UploadRequest {
  readonly key: string;
  readonly size: number;
  readonly overwrite: boolean;
}

/**
 * Why one file is not signed. `replace_unavailable`: a Replace whose stored
 * spelling could not be found for certain (see `storedSpelling`); the owner
 * replaces that file with rclone.
 */
export type UploadRefusal = PathRefusal | "empty_file" | "too_large" | "replace_unavailable";

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
 * The files of a sign request, or null unless it is 1–10 objects, each with a
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
  storage: LibraryStorage,
  prefix: string,
  file: UploadRequest,
  now: number,
): Promise<UploadResult> {
  const checked = checkUploadKey(file.key, prefix);
  if ("error" in checked) {
    return { key: newKeySpelling(file.key, prefix), error: checked.error };
  }
  const sizeRefusal = checkUploadSize(checked.kind, file.size);
  if (sizeRefusal !== null) {
    return { key: checked.key, error: sizeRefusal };
  }

  // One Class B operation. R2 treats NFC-equivalent keys as one object, so
  // this finds an object stored under another spelling too.
  const stored = await storage.head(checked.key);
  if (stored !== null && !file.overwrite) {
    return {
      key: checked.key,
      error: "exists",
      existing: { size: stored.size, uploadedAt: stored.uploaded.toISOString() },
    };
  }

  // The lookup compares in NFC, whatever spelling the prefix kept.
  const key =
    stored === null ? checked.key : await storedSpelling(storage, checked.key.normalize("NFC"));
  if (key === null) {
    return { key: checked.key, error: "replace_unavailable" };
  }
  const presigned = await storage.presignPut(
    { key, size: file.size, contentType: checked.contentType, replace: stored !== null },
    now,
  );
  if (presigned === null) {
    // The route checked that uploads are configured before signing anything.
    throw new Error("files: uploads stopped being configured mid-request");
  }

  return { key, ...presigned };
}

/**
 * The exact key, as R2 lists it, of the object `head(key)` found, for a
 * Replace to write under, or null when it cannot be found for certain. R2
 * treats Unicode-equivalent keys as one object but lists the spelling last
 * uploaded, so a Replace under another spelling would change the key the
 * scanner sees, and with it the track's id and its annotations (ADR-0002).
 * Whether `head()` answers the stored spelling or the one asked for is not
 * documented, so this never takes `head()`'s key.
 *
 * It walks the key's segments from the root:
 *
 * - a folder segment with one spelling (`hasOneSpelling`: ASCII, but for
 *   `K`, `;` and `` ` ``) is taken as it is;
 * - any other folder segment is looked up in the folder resolved so far: a
 *   delimited listing under the folder and the segment's one-spelling
 *   prefix, up to `SPELLING_PAGES_PER_SEGMENT` pages, must hold exactly one
 *   subfolder whose name is NFC-equal to it;
 * - the file name is looked up the same way among the folder's objects. It
 *   is taken as it is only when it, and every folder before it, has one
 *   spelling; once a folder was looked up, the object is too, so a folder
 *   chosen wrongly fails here rather than renaming the object.
 *
 * Null when a lookup finds no match (not in the pages listed), more than
 * one, or would make more than `SPELLING_LISTINGS` listings in all.
 */
async function storedSpelling(storage: LibraryStorage, key: string): Promise<string | null> {
  const segments = key.split("/");
  const name = segments.pop() ?? "";
  let budget = SPELLING_LISTINGS;
  let resolved = "";
  let lookedUp = false;

  for (const segment of segments) {
    if (hasOneSpelling(segment)) {
      resolved += `${segment}/`;
      continue;
    }
    const lookup = await lookUpSpelling(storage, resolved, segment, "folder", budget);
    if (lookup.found === null) {
      return null;
    }
    budget -= lookup.listings;
    resolved = lookup.found;
    lookedUp = true;
  }

  if (hasOneSpelling(name) && !lookedUp) {
    return resolved + name;
  }
  const lookup = await lookUpSpelling(storage, resolved, name, "object", budget);

  return lookup.found;
}

/**
 * Finds, in the folder `parent` (as stored, `""` for the root), the one
 * subfolder (`"folder"`: its prefix, ending in `/`) or object (`"object"`:
 * its key) whose name is NFC-equal to `segment`, in at most `budget`
 * listings. `found` is null when there is none in the pages listed, or more
 * than one.
 */
async function lookUpSpelling(
  storage: LibraryStorage,
  parent: string,
  segment: string,
  kind: "folder" | "object",
  budget: number,
): Promise<{ readonly found: string | null; readonly listings: number }> {
  const prefix = parent + oneSpellingPrefix(segment);
  let listings = 0;
  let cursor: string | undefined;

  while (listings < Math.min(budget, SPELLING_PAGES_PER_SEGMENT)) {
    const listing = await storage.list({ prefix, delimiter: "/", limit: SPELLING_PAGE, cursor });
    listings++;
    const entries =
      kind === "folder" ? listing.prefixes : listing.objects.map((object) => object.key);
    const matches = entries.filter((entry) => {
      if (!entry.startsWith(parent)) {
        return false;
      }
      const entryName = entry.slice(parent.length, kind === "folder" ? -1 : undefined);
      // An ASCII name is its own NFC: no need to normalise it.
      return isAscii(entryName) ? entryName === segment : entryName.normalize("NFC") === segment;
    });
    if (matches.length > 0 || listing.cursor === null) {
      return { found: matches.length === 1 ? (matches[0] ?? null) : null, listings };
    }
    cursor = listing.cursor;
  }

  return { found: null, listings };
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

/**
 * Which of `keys` exist. First by listing each one's folder (as given) and
 * comparing names in NFC (`matchListing`), in at most `CHECK_LISTINGS`
 * listings and `CHECK_ENTRIES` entries listed: a folder listed to its end
 * answers for every key in it. Then, for the keys whose folder was not, one
 * `head()` each, as many as the request's `CHECK_CALLS` binding calls have
 * room for: R2 finds a key under any Unicode spelling (`storedKey` is then
 * the key `head()` answers). What is still unknown is `unchecked`. A key
 * the upload rules refuse is in neither list.
 */
async function checkExisting(
  storage: LibraryStorage,
  prefix: string,
  keys: readonly string[],
): Promise<{ existing: ExistingKey[]; unchecked: string[] }> {
  const folders = groupCheckKeys(prefix, keys);
  const existing: ExistingKey[] = [];
  const unknown: string[] = [];
  let listings = 0;
  let entries = CHECK_ENTRIES;
  for (const [folder, names] of folders) {
    let cursor: string | undefined;
    while (names.size > 0 && listings < CHECK_LISTINGS && entries > 0) {
      const listing = await storage.list({
        prefix: folder,
        delimiter: "/",
        limit: Math.min(CHECK_PAGE, entries),
        cursor,
      });
      listings++;
      entries -= listing.objects.length + listing.prefixes.length;
      matchListing(folder, names, listing.objects, existing);
      if (listing.cursor === null) {
        // Listed to its end: no other key of it exists.
        names.clear();
        break;
      }
      cursor = listing.cursor;
    }
    // Every folder after the budget ran out is still to look for too.
    for (const asked of names.values()) {
      unknown.push(...asked);
    }
  }

  // One head() a key, with the calls left. Keys NFC-equal to one another
  // are grouped under one name for the listings, but each still gets its
  // own head() here, which R2 answers for either spelling.
  const heads = unknown.slice(0, Math.max(CHECK_CALLS - listings, 0));
  const found = await mapInFlight(heads, HEADS_IN_FLIGHT, (key) => storage.head(key));
  heads.forEach((key, index) => {
    const object = found[index];
    if (object) {
      existing.push({
        key,
        storedKey: object.key,
        size: object.size,
        uploadedAt: object.uploaded.toISOString(),
      });
    }
  });

  return { existing, unchecked: unknown.slice(heads.length) };
}

/** Whether `keys` is 1–500 strings, as an upload check takes them. */
function isCheckKeyList(keys: unknown): keys is string[] {
  return (
    Array.isArray(keys) &&
    keys.length >= 1 &&
    keys.length <= CHECK_BATCH &&
    keys.every((key) => typeof key === "string")
  );
}

/** Whether `keys` is 1–10 strings, as a complete request reports them. */
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
async function afterDelete(env: Env, keys: readonly string[]): Promise<ScanSchedule | null> {
  await deletePlaylistRowsByKeys(database(env), playlistKeysOf(keys));

  return recordLibraryChange(env, Date.now());
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
