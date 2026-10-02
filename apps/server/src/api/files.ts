import type { Context } from "hono";
import { requireFreshSession, requirePermission, requireSession } from "../console-auth/middleware";
import { database } from "../db";
import type { Env } from "../env";
import { fileWritesEnabled, requireFileWrites } from "../files/config";
import {
  ALLOWED,
  checkBrowsePrefix,
  checkFolderPrefix,
  isReservedKey,
  MAX_KEY_BYTES,
  MAX_SEGMENT_BYTES,
  utf8Length,
} from "../files/keys";
import { RESCAN_QUIET_MS, recordLibraryChange, type ScanSchedule } from "../files/library-change";
import { folderListing, playlistKeysOf } from "../files/listing";
import { deletePlaylistRowsByKeys } from "../playlists/repository";
import { eraseObjects } from "../playlists/writes";
import type { ApiApp } from "./app";
import { invalidRequest, limitFileDeleteBody, limitJsonBody, readJsonObject } from "./json-body";
import { requireSameOrigin } from "./same-origin";

/**
 * The console's Files page (#83): the bound bucket, `MUSIC`, browsed one
 * folder at a time, and files and folders deleted from it. Uploads are signed
 * by routes of their own (#83, "API: uploads").
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
 * - `GET /api/files/config`: `200 FilesConfig`, the allow-list, the limits,
 *   the quiet window and whether writes are enabled.
 * - `GET /api/files?prefix=&cursor=`: `200 {prefix, folders, files, cursor}`;
 *   `400 invalid_path`, `403 reserved_path`, `400 invalid_cursor` (a cursor
 *   R2 refuses: forged, stale or from another prefix).
 * - `POST /api/files/delete`, `{keys}`, 1–250 keys:
 *   `200 {deleted, scan}`; `400 invalid_request`, `403 reserved_path`.
 * - `POST /api/files/delete-folder`, `{prefix}`:
 *   `200 {deleted, done, scan}`, called again until `done`, or
 *   `200 {deleted: 0, done: true}`, with no `scan`, when there was nothing
 *   left to delete; `400 invalid_path`, `403 reserved_path`.
 * - Either write, where `FILE_WRITES` is `"off"`: `403 file_writes_disabled`.
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
 * Every answer that deleted something carries `scan`, what the driver will
 * do about the change (`ScanSchedule`, files/library-change.ts):
 *
 * - `{"scheduledAt": "<ISO 8601>", "afterCurrentPass": false}`: a pass
 *   starts at about that time, once the library has stayed quiet;
 * - `{"scheduledAt": null, "afterCurrentPass": true}`: a pass is running,
 *   and one more follows it for the change;
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
 */

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
      limits: {
        maxKeyBytes: MAX_KEY_BYTES,
        maxSegmentBytes: MAX_SEGMENT_BYTES,
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
    let listing: R2Objects;
    try {
      listing = await c.env.MUSIC.list({ prefix, delimiter: "/", limit: BROWSE_PAGE, cursor });
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

    // The keys of every delete call that succeeded.
    const deleted: string[] = [];
    let done = false;
    let completed = false;
    try {
      for (let page = 0; page < FOLDER_DELETE_PAGES && !done; page++) {
        const listing = await c.env.MUSIC.list({ prefix, limit: FOLDER_DELETE_PAGE });
        const keys = listing.objects.map((object) => object.key);
        await eraseObjects(c.env, keys);
        deleted.push(...keys);
        done = !listing.truncated;
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
