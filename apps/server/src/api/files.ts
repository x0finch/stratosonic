import type { Context } from "hono";
import { requireFreshSession, requirePermission, requireSession } from "../console-auth/middleware";
import { database } from "../db";
import type { Env } from "../env";
import { CHECK_BATCH, type ExistingKey, groupCheckKeys, matchListing } from "../files/check";
import { bucketName, fileWritesEnabled, requireFileWrites, uploadsStatus } from "../files/config";
import {
  ALLOWED,
  BOUND_RESERVED_PREFIXES,
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
  reservedPrefixesOf,
  utf8Length,
} from "../files/keys";
import { RESCAN_QUIET_MS, recordLibraryChange, type ScanSchedule } from "../files/library-change";
import { folderListing, playlistKeysOf } from "../files/listing";
import { findLibrary, listActiveLibraries } from "../libraries/repository";
import { deletePlaylistRowsByKeys } from "../playlists/repository";
import { BOUND_LIBRARY_ID, bindingStorage } from "../storage/binding";
import { storageFor } from "../storage/for-library";
import type { PresignedUpload } from "../storage/presign";
import { deleteRequests } from "../storage/s3";
import { type LibraryStorage, StorageError, type StorageListing } from "../storage/storage";
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
 * The console's Files page (#83; #84, "Files across libraries"): a library's
 * bucket browsed one folder at a time, files and folders deleted from it,
 * and files uploaded to it, all through the library's storage (`storageFor`,
 * storage/for-library.ts): the bound bucket, `MUSIC`, for library 1, and a
 * connected library's bucket over the S3 API. An upload's bytes go from the
 * browser straight to the bucket, with a URL the storage presigns
 * (`presignPut`, storage/presign.ts), and never through the Worker.
 *
 * R2 has no folders: a folder is a common key prefix ending in `/`, as a
 * delimited listing reports it. Keys are used exactly as R2 lists them, never
 * normalised (files/keys.ts). The scanner's own `_covers/` prefix is hidden
 * from browse and refused to every write, `403 {"error":"reserved_path"}`,
 * in library 1 only: every library's covers are written there, and a
 * connected bucket holds nothing of the scanner's (#84, "Covers").
 *
 * ## Which library
 *
 * Every route but the config takes a library: `?library=` on `GET
 * /api/files`, `"library"` in every write's body, a library id, 1 when
 * missing, so a console that sends none acts on the bound bucket exactly as
 * before. Library 1 is the binding, and is never read from D1: its requests
 * make the statements and calls they always made. Any other library's row is
 * read once, the one statement the route adds (`filesLibrary`):
 *
 * - an id no active library has (none, or one being removed) answers
 *   `404 {"error":"library_not_found"}`, and an id that is not an integer
 *   `404` too on `GET` (it names no library), `400 invalid_request` in a body;
 * - a write to a library whose last connection test found it read-only
 *   answers `403 {"error":"library_read_only"}`. Browsing it still works.
 *   The upload check counts as a write: it only serves an upload;
 * - `FILE_WRITES = "off"` refuses every library's writes, before any of this.
 *
 * Reads need a session, which the cookie cache may vouch for, and
 * `files:read`. Writes go through `requireSameOrigin`, a body cap,
 * `requireFreshSession` (D1, past the cookie cache), `files:write` and
 * `requireFileWrites` (files/config.ts), in that order; each sends a JSON
 * object, then has its body checked, then its library, then its paths. The
 * answers:
 *
 * - `GET /api/files/config`: `200 FilesConfig`, the bound bucket's name,
 *   whether its uploads are configured, the active libraries (`libraries:
 *   [{id, name, writable, uploads, reservedPrefixes}]`, one D1 statement),
 *   the allow-list, the limits, the quiet window and whether writes are
 *   enabled.
 * - `GET /api/files?library=&prefix=&cursor=`: `200 {prefix, folders, files,
 *   cursor}`; `400 invalid_path`, `403 reserved_path`, `400 invalid_cursor`
 *   (a cursor the bucket refuses: forged, stale or from another prefix).
 * - `POST /api/files/delete`, `{library?, keys}`, 1–250 keys:
 *   `200 {deleted, scan}`; `400 invalid_request`, `403 reserved_path`, and,
 *   in a connected library, `400 too_many_keys` when the keys holding a
 *   control character would need more than `S3_DELETE_CALLS` requests (each
 *   is deleted with its own `DeleteObject`).
 * - `POST /api/files/delete-folder`, `{library?, prefix}`:
 *   `200 {deleted, done, scan}`, called again until `done`, or
 *   `200 {deleted: 0, done: true}`, with no `scan`, when there was nothing
 *   left to delete; `400 invalid_path`, `403 reserved_path`.
 * - `POST /api/files/uploads`, `{library?, prefix?, files: [{key, size,
 *   overwrite?}]}`, 1–10 files: `200 {uploads}`, one result per file, in
 *   order, each a presigned `PUT` or a per-file `error` (`invalid_path`,
 *   `path_too_long`, `reserved_path`, `type_not_allowed`, `too_large`,
 *   `empty_file`, `exists`, or `replace_unavailable`: replace that file with
 *   rclone); `400 invalid_request`, and for library 1
 *   `503 uploads_not_configured` (a connected library's uploads are signed
 *   with its stored token, so they are always configured). `prefix` is the
 *   folder uploaded into, exactly as browse listed it: it is kept as it is,
 *   and only the part of each key after it is normalised to NFC; a key
 *   outside it answers `invalid_path` for that file, and a bad prefix
 *   `400 invalid_path` or `403 reserved_path` for the request.
 * - `POST /api/files/uploads/check`, `{library?, prefix?, keys}`, 1–500
 *   keys about to be uploaded: `200 {existing: [{key, storedKey, size,
 *   uploadedAt}], unchecked: [key]}`; `400 invalid_request`, and for a bad
 *   prefix `400 invalid_path` or `403 reserved_path`. It needs no upload
 *   configuration: it reads the bucket.
 * - `POST /api/files/uploads/complete`, `{library?, keys}`, 1–10 keys whose
 *   `PUT` succeeded: `200 {scan}`; `400 invalid_request`, `403 reserved_path`.
 * - Any route but the config, for a library that is not there or is being
 *   removed: `404 library_not_found`; any write, for a read-only library:
 *   `403 library_read_only`.
 * - Any write, where `FILE_WRITES` is `"off"`: `403 file_writes_disabled`.
 *
 * A connected bucket that fails (a refused token, a missing bucket, an
 * outage: a `StorageError`, storage/storage.ts) answers 500, as a failed
 * binding call does, but for a refused cursor (`400 invalid_cursor`).
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
 * (ADR-0006): the rows of every deleted key with a playlist suffix, in the
 * library the keys were deleted from (by `(library_id, r2_key)`, so another
 * library's playlist under the same key stays), are deleted right after the
 * objects, in one round trip.
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
 *    `CHECK_ENTRIES` (2,000; `S3_CHECK_ENTRIES`, 1,000, over the S3 API)
 *    entries listed in all, as much as one `delete-folder` round. A key
 *    whose folder was not listed to its end (a large flat folder, or one
 *    past the budget) is then looked for with one `head()` (Class B), as
 *    many as the request's `CHECK_CALLS` (46) storage calls leave room
 *    for: at least 6. A key still unknown is
 *    answered in `unchecked`, never as new, and the console asks again for
 *    those, each request with a fresh budget. A folder stored in another
 *    spelling than the one given lists nothing, so its keys read as new;
 *    the `PUT`'s `If-None-Match: *` still refuses them. Its cost: one
 *    `ListObjects` (Class A) per page and one `HeadObject` (Class B) per
 *    key looked up, no D1 statement past the session check's and a
 *    connected library's row, no driver call: 46 storage calls + at most 3
 *    D1 statements for the session + 1 for the library = 50 subrequests
 *    (`requireFreshSession` reads the session and its user, and updates
 *    the session once it is past `updateAge`). At most `CHECK_BATCH` (500)
 *    keys a request: checking them against the upload rules is most of its
 *    CPU. A `head()` over the S3 API answers null for a missing bucket as
 *    for a missing key, but a listing always comes first, and a listing
 *    tells a missing bucket apart (`bucket_not_found`).
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
 *    Over the S3 API, a `head()` answers null for a missing bucket as for a
 *    missing key (a `HEAD` has no body to tell them apart), so a connected
 *    library's request lists one key of the bucket before it trusts the
 *    first null (`confirmBucket`): a missing bucket then fails the request,
 *    rather than every file reading as new and every browser `PUT` failing.
 *
 *    Its cost: one `HeadObject` (Class B) per file that passes the rules,
 *    and, for a Replace of an existing key with more than one possible
 *    spelling, one `ListObjects` (Class A) per page listed to find it, at
 *    most `SPELLING_LISTINGS` (3) a file. So a request of 10 files makes at
 *    most 10 + 30 = 40 storage calls (a connected library's one confirming
 *    listing is made only when a file is new, which leaves at most 27
 *    lookups), and with the session check's D1 statements (at most 2) and a
 *    connected library's row at most 43 subrequests, inside the 50.
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
 * The most storage calls one upload check makes, listings and `head()`s
 * together: 46 storage calls + at most 3 D1 statements for the session + 1
 * for a connected library's row = 50 subrequests. The session check
 * (`requireFreshSession`) reads the session and its user, and updates the
 * session once it is past Better Auth's `updateAge`
 * (test/console-auth-sessions.test.ts). Library 1 reads no row, and keeps
 * the same bound (#84, "Files across libraries").
 */
export const CHECK_CALLS = 46;

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

/**
 * `CHECK_ENTRIES` over the S3 API: 1,000, since each entry is also XML the
 * route parses (storage/s3-list.ts, about 3 ms per 1,000 entries in workerd,
 * scripts/bench-files.ts), so the request stays inside its 10 ms (#84, "CPU").
 */
export const S3_CHECK_ENTRIES = 1000;

/** The keys one listing of an upload check reaches at most: R2's own most. */
const CHECK_PAGE = 1000;

/** The most keys one `POST /api/files/delete` takes; the body cap is sized for it. */
export const DELETE_BATCH = 250;

/** The most entries one browse page lists: R2's own most. */
const BROWSE_PAGE = 1000;

/** The most keys one listing of a folder delete reaches: R2's own most. */
export const FOLDER_DELETE_PAGE = 1000;

/**
 * `FOLDER_DELETE_PAGE` over the S3 API: 500, so a round's two listings parse
 * 1,000 entries of XML, inside the request's 10 ms (#84, "CPU").
 */
export const S3_FOLDER_DELETE_PAGE = 500;

/**
 * The most S3 requests a connected library's delete, or folder-delete round,
 * makes: its listings, its `DeleteObjects` and, for each key holding a
 * character XML cannot carry, that key's own `DeleteObject`
 * (`deleteRequests`, storage/s3.ts). With at most 3 D1 statements for the
 * session, 1 for the library's row, 1 for the playlists' rows, 1 for the
 * change and 1 driver call, a request stays at 47 subrequests of the 50.
 * The binding deletes any keys in one call, so library 1 needs no bound.
 */
export const S3_DELETE_CALLS = 40;

/**
 * The listings one `delete-folder` request makes at most: 2,000 keys, which
 * keeps the request inside its 10 ms of CPU and far inside the subrequests.
 */
const FOLDER_DELETE_PAGES = 2;

export function registerFileRoutes(api: ApiApp): void {
  const write = [requireFreshSession, requirePermission("files:write"), requireFileWrites] as const;

  /**
   * `GET /api/files/config`: what the console needs to know once a session,
   * with no storage call and one D1 statement, the active libraries.
   */
  api.get("/files/config", requireSession, requirePermission("files:read"), async (c) => {
    const libraries = await listActiveLibraries(database(c.env));

    return c.json({
      allowed: ALLOWED,
      // R2_BUCKET_NAME, or null when unset.
      bucket: bucketName(c.env),
      // Whether library 1's uploads can be signed here; `missing` names the
      // values that are not set, never their contents.
      uploads: uploadsView(c.env),
      // Every active library, by id, and what the Files page may do in it.
      libraries: libraries.map((row) => {
        const bound = row.id === BOUND_LIBRARY_ID;
        return {
          id: row.id,
          name: row.name,
          // Library 1 is always written to, as the routes take it (`filesLibrary`).
          writable: bound || row.writable,
          // A connected library's uploads are signed with its stored token.
          uploads: bound ? uploadsView(c.env) : { configured: true as const },
          reservedPrefixes: reservedPrefixesOf(row.id),
        };
      }),
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
    });
  });

  /**
   * `GET /api/files`: one page of one folder of a library, in one storage
   * call (`folderListing`). `library` is 1 when missing, `prefix` the root;
   * `cursor` is the bucket's, null on the last page.
   *
   * A listing the bucket refuses while carrying a cursor answers
   * `400 {"error":"invalid_cursor"}`: the cursor came from the client, and
   * the bucket is what decides it is not one of its own. The console's
   * answer is the same either way, to open the folder again from its first
   * page. Without a cursor, a failed listing is the 500 it is, and so is any
   * other failure a connected bucket names (`StorageError`).
   */
  api.get("/files", requireSession, requirePermission("files:read"), async (c) => {
    const library = await filesLibrary(c, queryLibraryId(c.req.query("library")), "read");
    if (library instanceof Response) {
      return library;
    }
    const prefix = c.req.query("prefix") ?? "";
    const refusal = checkBrowsePrefix(prefix, library.reserved);
    if (refusal !== null) {
      return refused(c, refusal);
    }

    const cursor = c.req.query("cursor") || undefined;
    let listing: StorageListing;
    try {
      listing = await library.storage.list({
        prefix,
        delimiter: "/",
        limit: BROWSE_PAGE,
        cursor,
      });
    } catch (error) {
      if (
        cursor === undefined ||
        (error instanceof StorageError && error.reason !== "invalid_cursor")
      ) {
        throw error;
      }
      console.warn("files: the bucket refused a listing's cursor", error);
      return c.json({ error: "invalid_cursor" }, 400);
    }

    return c.json(folderListing(prefix, listing, library.reserved));
  });

  /**
   * `POST /api/files/delete` with `{library?, keys}`: 1–250 keys, exactly as
   * browse listed them, deleted in one storage call. A key that is not there
   * is not an error, so `deleted` counts the distinct keys given.
   */
  api.post("/files/delete", requireSameOrigin, limitFileDeleteBody, ...write, async (c) => {
    const body = (await readJsonObject(c)) ?? {};
    const libraryId = bodyLibraryId(body.library);
    const { keys } = body;
    if (!isKeyList(keys) || libraryId === null) {
      return invalidRequest(c);
    }
    const library = await filesLibrary(c, libraryId, "write");
    if (library instanceof Response) {
      return library;
    }
    if (keys.some((key) => isReservedKey(key, library.reserved))) {
      // The whole request, before any object is touched.
      return refused(c, "reserved_path");
    }

    const distinct = [...new Set(keys)];
    if (library.overS3 && deleteRequests(distinct) > S3_DELETE_CALLS) {
      // Keys with a control character are deleted one request each: more
      // than a request may make. The console deletes fewer at a time.
      return c.json({ error: "too_many_keys" }, 400);
    }
    await library.storage.delete(distinct);
    const scan = await afterDelete(c.env, library.id, distinct);

    return c.json({ deleted: distinct.length, scan });
  });

  /**
   * `POST /api/files/delete-folder` with `{library?, prefix}`: every key
   * under the prefix, at any depth, at most `FOLDER_DELETE_PAGES` listings of
   * `FOLDER_DELETE_PAGE` keys a request (`S3_FOLDER_DELETE_PAGE` over the S3
   * API, where a round also stops at `S3_DELETE_CALLS` requests). `done` is
   * true once a listing comes back complete and every key of it is deleted;
   * until then the console calls again.
   *
   * Each listing starts from the beginning of the prefix, since the keys the
   * one before it found are gone, so the request needs no cursor. A file
   * uploaded into the folder while it is being deleted is deleted too, which
   * is what was asked.
   */
  api.post("/files/delete-folder", requireSameOrigin, limitJsonBody, ...write, async (c) => {
    const body = (await readJsonObject(c)) ?? {};
    const libraryId = bodyLibraryId(body.library);
    const { prefix } = body;
    if (typeof prefix !== "string" || libraryId === null) {
      return invalidRequest(c);
    }
    const library = await filesLibrary(c, libraryId, "write");
    if (library instanceof Response) {
      return library;
    }
    const refusal = checkFolderPrefix(prefix, library.reserved);
    if (refusal !== null) {
      return refused(c, refusal);
    }

    const { storage, overS3 } = library;
    const page = overS3 ? S3_FOLDER_DELETE_PAGE : FOLDER_DELETE_PAGE;
    // The keys of every delete call that succeeded.
    const deleted: string[] = [];
    let done = false;
    let completed = false;
    // The S3 requests made so far, which `S3_DELETE_CALLS` bounds.
    let calls = 0;
    try {
      for (let listed = 0; listed < FOLDER_DELETE_PAGES && !done; listed++) {
        if (overS3 && calls + 2 > S3_DELETE_CALLS) {
          // No room for a listing and a delete after it: the next round.
          break;
        }
        const listing = await storage.list({ prefix, limit: page });
        calls++;
        let keys = listing.objects.map((object) => object.key);
        if (overS3) {
          const fitting = keysWithin(keys, S3_DELETE_CALLS - calls);
          keys = fitting < keys.length ? keys.slice(0, fitting) : keys;
          calls += deleteRequests(keys);
        }
        await storage.delete(keys);
        deleted.push(...keys);
        done = listing.cursor === null && keys.length === listing.objects.length;
        if (keys.length < listing.objects.length) {
          break;
        }
      }
      completed = true;
    } finally {
      // A round that failed half way still accounts for what it deleted, and
      // the error then goes on to the 500 handler. A failure of that work is
      // logged rather than hiding the first one.
      if (!completed && deleted.length > 0) {
        await afterDelete(c.env, library.id, deleted).catch((error: unknown) => {
          console.error("files: recording a half-done folder delete failed", error);
        });
      }
    }

    if (deleted.length === 0) {
      return c.json({ deleted: 0, done });
    }

    const scan = await afterDelete(c.env, library.id, deleted);
    return c.json({ deleted: deleted.length, done, scan });
  });

  /**
   * `POST /api/files/uploads` with `{library?, prefix?, files}`: 1–10 files
   * to sign, each `{key, size, overwrite?}`, in the folder `prefix` (as
   * listed, never normalised) when given. A refused file does not fail the
   * others: the request answers 200 with one result per file, in order.
   */
  api.post("/files/uploads", requireSameOrigin, limitJsonBody, ...write, async (c) => {
    const body = (await readJsonObject(c)) ?? {};
    const libraryId = bodyLibraryId(body.library);
    // Library 1's uploads need Phase 2's secrets, and say so first, as
    // they always have; a connected library signs with its stored token.
    if (libraryId === BOUND_LIBRARY_ID && !uploadsStatus(c.env).configured) {
      return c.json({ error: "uploads_not_configured" }, 503);
    }

    const { prefix = "", files } = body;
    const requested = readUploadRequests(files);
    if (requested === null || typeof prefix !== "string" || libraryId === null) {
      return invalidRequest(c);
    }
    const library = await filesLibrary(c, libraryId, "write");
    if (library instanceof Response) {
      return library;
    }
    const prefixRefusal = checkUploadPrefix(prefix, library.reserved);
    if (prefixRefusal !== null) {
      return refused(c, prefixRefusal);
    }

    // One instant for the whole batch: every URL expires together.
    const now = Date.now();
    const { storage } = library;
    const confirmBucket = library.overS3 ? bucketConfirmation(storage) : noConfirmation;
    const uploads = await mapInFlight(requested, HEADS_IN_FLIGHT, (file) =>
      signUpload(storage, library.reserved, confirmBucket, prefix, file, now),
    );

    return c.json({ uploads });
  });

  /**
   * `POST /api/files/uploads/check` with `{library?, prefix?, keys}`: which
   * of 1–500 keys already exist, as the console asks before a pick is signed
   * (see "Uploads", step 0). It reads only the bucket, so it works where
   * uploads are not configured.
   */
  api.post("/files/uploads/check", requireSameOrigin, limitFileCheckBody, ...write, async (c) => {
    const body = (await readJsonObject(c)) ?? {};
    const libraryId = bodyLibraryId(body.library);
    const { prefix = "", keys } = body;
    if (!isCheckKeyList(keys) || typeof prefix !== "string" || libraryId === null) {
      return invalidRequest(c);
    }
    const library = await filesLibrary(c, libraryId, "write");
    if (library instanceof Response) {
      return library;
    }
    const prefixRefusal = checkUploadPrefix(prefix, library.reserved);
    if (prefixRefusal !== null) {
      return refused(c, prefixRefusal);
    }

    return c.json(await checkExisting(library, prefix, keys));
  });

  /**
   * `POST /api/files/uploads/complete` with `{library?, keys}`: 1–10 keys
   * whose `PUT` the bucket accepted. It records the change, in one D1
   * statement and one call to the scan driver, and answers what the driver
   * will do about it.
   */
  api.post("/files/uploads/complete", requireSameOrigin, limitJsonBody, ...write, async (c) => {
    const body = (await readJsonObject(c)) ?? {};
    const libraryId = bodyLibraryId(body.library);
    const { keys } = body;
    if (!isCompletedKeyList(keys) || libraryId === null) {
      return invalidRequest(c);
    }
    const library = await filesLibrary(c, libraryId, "write");
    if (library instanceof Response) {
      return library;
    }
    const refusals = keys
      .map((key) => checkUploadKey(key, "", library.reserved))
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

/** The library a Files request acts on, once it has been found (`filesLibrary`). */
export interface FilesLibrary {
  readonly id: number;
  /** Its bucket: the binding for library 1, the S3 API for a connected library. */
  readonly storage: LibraryStorage;
  /** `reservedPrefixesOf`: `_covers/` in library 1, none elsewhere. */
  readonly reserved: readonly string[];
  /** Whether its bucket is reached over the S3 API, with the tighter bounds that brings. */
  readonly overS3: boolean;
}

/** Library 1, the bound bucket: never read from D1, never read-only, never removed. */
function boundLibrary(env: Env): FilesLibrary {
  return {
    id: BOUND_LIBRARY_ID,
    storage: bindingStorage(env),
    reserved: BOUND_RESERVED_PREFIXES,
    overS3: false,
  };
}

/**
 * The library a request names, or the refusal to answer instead:
 *
 * - library 1 is the bound bucket, with no D1 statement, so its requests
 *   cost what they always did;
 * - any other id is read from D1 (one statement, one row), and is
 *   `404 library_not_found` when no library has it, or the one that has it
 *   is being removed, and, for a write, `403 library_read_only` when its
 *   last connection test found it read-only. Its storage is built from the
 *   row (`storageFor`), and its token opened only when a request needs it.
 *
 * `null` is an id that names no library (a malformed `?library=`).
 */
async function filesLibrary(
  c: Context,
  id: number | null,
  access: "read" | "write",
): Promise<FilesLibrary | Response> {
  if (id === BOUND_LIBRARY_ID) {
    return boundLibrary(c.env);
  }
  const row = id === null ? undefined : await findLibrary(database(c.env), id);
  if (row === undefined || row.state !== "active") {
    return c.json({ error: "library_not_found" }, 404);
  }
  if (access === "write" && !row.writable) {
    return c.json({ error: "library_read_only" }, 403);
  }

  return {
    id: row.id,
    storage: storageFor(c.env, row),
    reserved: reservedPrefixesOf(row.id),
    overS3: row.kind === "s3",
  };
}

/** `?library=`: 1 when missing, a positive integer, or null for anything else. */
function queryLibraryId(value: string | undefined): number | null {
  if (value === undefined) {
    return BOUND_LIBRARY_ID;
  }
  if (!/^[1-9][0-9]{0,15}$/.test(value)) {
    return null;
  }
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * A write body's `library`: 1 when missing, the integer given, or null when
 * it is not an integer, which the route answers `400 invalid_request`. An
 * integer no library has is the route's `404 library_not_found`.
 */
function bodyLibraryId(value: unknown): number | null {
  if (value === undefined) {
    return BOUND_LIBRARY_ID;
  }
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * How many of `keys`, from the first, one delete makes in at most `budget`
 * requests (`deleteRequests`, which never falls as keys are added).
 */
function keysWithin(keys: readonly string[], budget: number): number {
  if (deleteRequests(keys) <= budget) {
    return keys.length;
  }
  let fits = 0;
  let over = keys.length;
  while (over - fits > 1) {
    const middle = Math.floor((fits + over) / 2);
    if (deleteRequests(keys.slice(0, middle)) <= budget) {
      fits = middle;
    } else {
      over = middle;
    }
  }
  return fits;
}

/**
 * Proves the bucket exists before a null `head()` is taken as a missing
 * key: over the S3 API, a `HEAD` to a missing bucket answers `404` with no
 * body, as one to a missing key does, so the S3 client answers null for
 * both (storage/s3.ts). One listing of one key does it, once a request, on
 * the first null; a missing bucket throws there (`bucket_not_found`).
 */
function bucketConfirmation(storage: LibraryStorage): () => Promise<void> {
  let confirmed: Promise<void> | null = null;
  return () => {
    confirmed ??= storage.list({ limit: 1 }).then(() => {});
    return confirmed;
  };
}

/** The bound bucket is the binding's, which cannot be missing: its null `head()` is a missing key. */
const noConfirmation = async (): Promise<void> => {};

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

/** Library 1's `uploads` in `GET /api/files/config`: Phase 2's secrets (files/config.ts). */
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
  reserved: readonly string[],
  confirmBucket: () => Promise<void>,
  prefix: string,
  file: UploadRequest,
  now: number,
): Promise<UploadResult> {
  const checked = checkUploadKey(file.key, prefix, reserved);
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
  if (stored === null) {
    // A missing key, once the bucket is known to be there.
    await confirmBucket();
  }
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
 * Which of `keys` exist in a library. First by listing each one's folder (as
 * given) and comparing names in NFC (`matchListing`), in at most
 * `CHECK_LISTINGS` listings and `CHECK_ENTRIES` entries listed
 * (`S3_CHECK_ENTRIES` over the S3 API): a folder listed to its end answers
 * for every key in it. Then, for the keys whose folder was not, one `head()`
 * each, as many as the request's `CHECK_CALLS` storage calls have room for:
 * R2 finds a key under any Unicode spelling (`storedKey` is then the key
 * `head()` answers). What is still unknown is `unchecked`. A key the upload
 * rules refuse is in neither list.
 *
 * The first folder is always listed before any `head()`, so a missing
 * bucket fails that listing over the S3 API, and a null `head()` after it
 * is a missing key.
 */
async function checkExisting(
  library: FilesLibrary,
  prefix: string,
  keys: readonly string[],
): Promise<{ existing: ExistingKey[]; unchecked: string[] }> {
  const { storage } = library;
  const folders = groupCheckKeys(prefix, keys, library.reserved);
  const existing: ExistingKey[] = [];
  const unknown: string[] = [];
  let listings = 0;
  let entries = library.overS3 ? S3_CHECK_ENTRIES : CHECK_ENTRIES;
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
 * What follows the deletion of these objects from a library's bucket: the
 * rows of the playlists they were, in that library only (by `(library_id,
 * r2_key)`: another library's playlist under the same key stays), then the
 * record of the change, which schedules the pass that takes the deleted
 * tracks out of the library.
 */
async function afterDelete(
  env: Env,
  libraryId: number,
  keys: readonly string[],
): Promise<ScanSchedule | null> {
  await deletePlaylistRowsByKeys(database(env), [{ libraryId, keys: playlistKeysOf(keys) }]);

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
