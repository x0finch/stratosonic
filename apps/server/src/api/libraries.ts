import { DEFAULT_LIBRARY_ID, type Library } from "@stratosonic/db";
import type { Context } from "hono";
import { requireFreshSession, requirePermission, requireSession } from "../console-auth/middleware";
import { database } from "../db";
import type { Env } from "../env";
import { uploadsStatus } from "../files/config";
import {
  acceptableKey,
  acceptableLibraryName,
  accountOf,
  type ConnectionResult,
  endpointOf,
  isAccountId,
  isBoundBucket,
  isBucketName,
  testConnection,
} from "../libraries/connection";
import {
  findConflicts,
  findLibrary,
  insertLibrary,
  type LibraryChanges,
  type LibraryCounts,
  libraryConflict,
  listLibraries,
  markLibraryRemoving,
  NO_COUNTS,
  readLibraries,
  recordConnectionTest,
  sqliteLower,
  updateLibrary,
} from "../libraries/repository";
import type { PokeOutcome } from "../scanner/driver";
import { listingFailure } from "../scanner/listing-failure";
import { pokeScanDriver } from "../scanner/status";
import { bindingStorage } from "../storage/binding";
import { openCredentials, type StorageCredentials, sealCredentials } from "../storage/credentials";
import { R2_REGION } from "../storage/presign";
import { s3Path, s3Storage } from "../storage/s3";
import type { ApiApp } from "./app";
import { invalidRequest, limitJsonBody, readJsonObject } from "./json-body";
import { requireSameOrigin } from "./same-origin";

/**
 * The console's Libraries API (#84, "Libraries API"; ADR-0009): the buckets
 * this server serves, connecting another R2 bucket with a token, editing,
 * testing and removing one.
 *
 * Reads go through `requireSession` and `libraries:read`; writes through
 * `requireSameOrigin`, `limitJsonBody`, `requireFreshSession` and
 * `libraries:write`, in that order, as #82's routes do. Every write sends a
 * JSON object, `{}` for a test or a delete. The answers:
 *
 * - `GET /api/libraries`: `200 {"libraries": LibraryView[], "defaultAccountId"}`,
 *   in one batch (the rows, and the album aggregates by library).
 * - `POST /api/libraries`, `{name, accountId, bucket, accessKeyId,
 *   secretAccessKey, defaultNewUsers?}`: `201 {"library", "scan"}`;
 *   `400 invalid_request` (a name that is not 1-64 characters trimmed, or a
 *   field of the wrong type), `400 invalid_account_id`, `400 invalid_bucket`,
 *   `409 name_taken`, `409 already_connected` (the bound bucket, or a path a
 *   library has), `422 connection_failed {reason}` (nothing is stored).
 * - `PATCH /api/libraries/:id`, `{name?, defaultNewUsers?, accountId?,
 *   bucket?, accessKeyId?, secretAccessKey?}`, at least one, the two keys
 *   together: `200 {"library", "scan"}`; the POST's refusals, and
 *   `404 not_found`, `409 removing`, and `409 default_library` for a field
 *   library 1 does not take (it takes `name` and `defaultNewUsers` only).
 * - `POST /api/libraries/:id/test`: `200 {"ok": true, "writable"} |
 *   {"ok": false, "reason"}`, library 1's with `uploads`; `404 not_found`,
 *   `409 removing`.
 * - `DELETE /api/libraries/:id`: `200 {"removed": {tracks, albums,
 *   playlists}}`; `404 not_found`, `409 default_library`, `409 removing`.
 *
 * **Secrets.** A token is taken, tested, sealed (storage/credentials.ts) and
 * stored; no answer and no log line ever carries it. A library is shown
 * with `accessKeyIdHint`, the Access Key ID's last four characters.
 *
 * **Where a token is sent.** Only to `https://<32-hex account>.r2.cloudflarestorage.com`:
 * the endpoint is built from a validated account id here, and the S3 client
 * asserts it again on every request (storage/s3.ts).
 */

/** A library as the console sees one. It never carries a key. */
export interface LibraryView {
  readonly id: number;
  readonly name: string;
  readonly kind: Library["kind"];
  readonly accountId: string | null;
  readonly bucket: string | null;
  /** `…` and the Access Key ID's last four characters; null for library 1 or a token that does not open. */
  readonly accessKeyIdHint: string | null;
  readonly writable: boolean;
  readonly defaultNewUsers: boolean;
  readonly state: Library["state"];
  readonly lastScanStartedAt: string | null;
  readonly lastScanAt: string | null;
  readonly lastScanError: string | null;
  readonly counts: LibraryCounts;
}

/** The S3 client's per-isolate cache key for a bucket that is not a library yet. */
const CANDIDATE_LIBRARY_ID = 0;

export function registerLibraryRoutes(api: ApiApp): void {
  const write = [
    requireSameOrigin,
    limitJsonBody,
    requireFreshSession,
    requirePermission("libraries:write"),
  ] as const;

  api.get("/libraries", requireSession, requirePermission("libraries:read"), async (c) => {
    const { libraries, counts } = await listLibraries(database(c.env));
    const views = await Promise.all(
      libraries.map((row) => viewOf(c.env, row, counts.get(row.id) ?? NO_COUNTS)),
    );

    return c.json({ libraries: views, defaultAccountId: setting(c.env.CF_ACCOUNT_ID) });
  });

  api.post("/libraries", ...write, async (c) => {
    const body = await readJsonObject(c);
    if (body === null) {
      return invalidRequest(c);
    }
    const { name, accountId, bucket, accessKeyId, secretAccessKey, defaultNewUsers = false } = body;
    if (
      typeof name !== "string" ||
      typeof accountId !== "string" ||
      typeof bucket !== "string" ||
      typeof accessKeyId !== "string" ||
      typeof secretAccessKey !== "string" ||
      typeof defaultNewUsers !== "boolean"
    ) {
      return invalidRequest(c);
    }

    const libraryName = acceptableLibraryName(name);
    if (libraryName === null) {
      return invalidRequest(c);
    }
    if (!isAccountId(accountId)) {
      return refusal(c, "invalid_account_id");
    }
    if (!isBucketName(bucket)) {
      return refusal(c, "invalid_bucket");
    }
    const credentials = keyPair(accessKeyId, secretAccessKey);
    if (credentials === null) {
      return invalidRequest(c);
    }

    const endpoint = endpointOf(accountId);
    const path = s3Path({ endpoint, bucket });
    if (isBoundBucket(c.env, accountId, bucket)) {
      return refusal(c, "already_connected");
    }

    const db = database(c.env);
    const conflicts = await findConflicts(db, libraryName, path);
    if (conflicts.nameTaken) {
      return refusal(c, "name_taken");
    }
    if (conflicts.pathTaken) {
      return refusal(c, "already_connected");
    }

    const tested = await testConnection(
      s3Storage({ libraryId: CANDIDATE_LIBRARY_ID, endpoint, bucket, path }, credentials),
    );
    if (!tested.ok) {
      return connectionFailed(c, tested);
    }

    let created: Library;
    try {
      created = await insertLibrary(db, {
        name: libraryName,
        path,
        endpoint,
        region: R2_REGION,
        bucket,
        credentials: await sealCredentials(c.var.passphrase, path, credentials),
        writable: tested.writable,
        defaultNewUsers,
      });
    } catch (error) {
      const conflict = libraryConflict(error);
      if (conflict !== null) {
        return refusal(c, conflict === "name" ? "name_taken" : "already_connected");
      }
      throw error;
    }
    console.log(`admin api: library ${created.id} connected`);

    return c.json(
      {
        library: await viewOf(c.env, created, NO_COUNTS, credentials),
        scan: await poke(c.env),
      },
      201,
    );
  });

  api.patch("/libraries/:id", ...write, async (c) => {
    const body = await readJsonObject(c);
    if (body === null) {
      return invalidRequest(c);
    }
    const request = patchRequest(body);
    if (typeof request === "string") {
      return request === "invalid_request" ? invalidRequest(c) : refusal(c, request);
    }

    const id = libraryIdOf(c.req.param("id"));
    if (id === null) {
      return notFound(c);
    }
    const connection = request.accountId ?? request.bucket ?? request.credentials;
    if (id === DEFAULT_LIBRARY_ID && connection !== undefined) {
      return refusal(c, "default_library");
    }

    const db = database(c.env);
    const libraries = await readLibraries(db);
    const row = libraries.find((entry) => entry.id === id);
    if (row === undefined) {
      return notFound(c);
    }
    if (row.state !== "active") {
      return refusal(c, "removing");
    }
    const others = libraries.filter((entry) => entry.id !== id);
    if (
      request.name !== undefined &&
      others.some((entry) => sqliteLower(entry.name) === sqliteLower(request.name ?? ""))
    ) {
      return refusal(c, "name_taken");
    }

    const changes: { -readonly [K in keyof LibraryChanges]: LibraryChanges[K] } = {};
    if (request.name !== undefined) changes.name = request.name;
    if (request.defaultNewUsers !== undefined) changes.defaultNewUsers = request.defaultNewUsers;

    // A changed account, bucket or key re-tests; a changed account or bucket
    // changes the path, and re-seals the token under it. An account and a
    // bucket sent as they are change nothing.
    let pathChanged = false;
    if (connection !== undefined) {
      const accountId = request.accountId ?? accountOf(row.endpoint);
      const bucket = request.bucket ?? row.bucket;
      if (accountId === null || bucket === null) {
        // A connected library always has both; a row that does not is not
        // one this API wrote.
        throw new Error(`library ${id} has no R2 endpoint or bucket`);
      }
      const endpoint = endpointOf(accountId);
      const path = s3Path({ endpoint, bucket });
      pathChanged = path !== row.path;
      if (
        pathChanged &&
        (isBoundBucket(c.env, accountId, bucket) || others.some((entry) => entry.path === path))
      ) {
        return refusal(c, "already_connected");
      }
      if (!pathChanged && request.credentials === undefined) {
        // Nothing about the connection changes.
      } else {
        const changed = await reconnect(c.var.passphrase, row, {
          endpoint,
          bucket,
          path,
          credentials: request.credentials,
        });
        if (!changed.ok) {
          return connectionFailed(c, changed);
        }
        Object.assign(changes, changed.changes);
      }
    }

    let updated: Awaited<ReturnType<typeof updateLibrary>>;
    try {
      updated = await updateLibrary(db, id, changes, pathChanged);
    } catch (error) {
      const conflict = libraryConflict(error);
      if (conflict !== null) {
        return refusal(c, conflict === "name" ? "name_taken" : "already_connected");
      }
      throw error;
    }
    if (updated === null) {
      return refusal(c, "removing");
    }
    if (pathChanged) {
      console.log(`admin api: library ${id} moved to another bucket`);
    }

    return c.json({
      library: await viewOf(c.env, updated.library, updated.counts),
      scan: pathChanged ? await poke(c.env) : null,
    });
  });

  api.post("/libraries/:id/test", ...write, async (c) => {
    if ((await readJsonObject(c)) === null) {
      return invalidRequest(c);
    }
    const id = libraryIdOf(c.req.param("id"));
    if (id === null) {
      return notFound(c);
    }

    const db = database(c.env);
    const row = await findLibrary(db, id);
    if (row === undefined) {
      return notFound(c);
    }
    if (row.state !== "active") {
      return refusal(c, "removing");
    }

    if (row.kind === "r2-binding") {
      // The bound bucket: a listing through the binding, which raises no
      // reason of its own, and whether uploads are configured.
      let result: ConnectionResult;
      try {
        await bindingStorage(c.env).list({ limit: 1 });
        result = { ok: true, writable: true };
      } catch (error) {
        result = { ok: false, reason: listingFailure(error) };
      }
      await recordConnectionTest(db, id, recorded(result));
      return c.json(
        result.ok ? { ...result, uploads: uploadsStatus(c.env).configured } : { ...result },
      );
    }

    let result: ConnectionResult;
    try {
      const credentials = await openStored(c.var.passphrase, row);
      result = await testConnection(
        s3Storage(
          {
            libraryId: id,
            endpoint: row.endpoint ?? "",
            bucket: row.bucket ?? "",
            path: row.path,
          },
          credentials,
        ),
      );
    } catch {
      // The stored token does not open: another key, or a tampered row.
      result = { ok: false, reason: "auth" };
    }
    await recordConnectionTest(db, id, recorded(result));

    return c.json({ ...result });
  });

  api.delete("/libraries/:id", ...write, async (c) => {
    if ((await readJsonObject(c)) === null) {
      return invalidRequest(c);
    }
    const id = libraryIdOf(c.req.param("id"));
    if (id === null) {
      return notFound(c);
    }
    if (id === DEFAULT_LIBRARY_ID) {
      return refusal(c, "default_library");
    }

    const outcome = await markLibraryRemoving(database(c.env), id);
    if ("refused" in outcome) {
      return outcome.refused === "not_found" ? notFound(c) : refusal(c, outcome.refused);
    }
    console.log(`admin api: library ${id} is being removed`);
    // The cleanup is the first phase of a pass: one starts now, or the pass
    // in flight runs it at its next step.
    await poke(c.env);

    return c.json({ removed: outcome.removed });
  });
}

/** The refusals the routes answer, with their statuses. */
const REFUSALS = {
  invalid_account_id: 400,
  invalid_bucket: 400,
  name_taken: 409,
  already_connected: 409,
  default_library: 409,
  removing: 409,
} as const;

type Refusal = keyof typeof REFUSALS;

function refusal(c: Context, error: Refusal) {
  return c.json({ error }, REFUSALS[error]);
}

function notFound(c: Context) {
  return c.json({ error: "not_found" }, 404);
}

function connectionFailed(c: Context, result: Extract<ConnectionResult, { ok: false }>) {
  return c.json({ error: "connection_failed", reason: result.reason }, 422);
}

/** What a test stamps on the library: `writable` when it got that far, and the failure. */
function recorded(result: ConnectionResult) {
  return result.ok ? { writable: result.writable, error: null } : { error: result.reason };
}

/** A library id in a path: a positive integer, or null, which names none. */
function libraryIdOf(value: string): number | null {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) {
    return null;
  }
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/** The two keys, each trimmed and present, or null. */
function keyPair(accessKeyId: string, secretAccessKey: string): StorageCredentials | null {
  const id = acceptableKey(accessKeyId);
  const secret = acceptableKey(secretAccessKey);
  return id === null || secret === null ? null : { accessKeyId: id, secretAccessKey: secret };
}

/** A `PATCH` body, read. */
interface PatchRequest {
  readonly name?: string;
  readonly defaultNewUsers?: boolean;
  readonly accountId?: string;
  readonly bucket?: string;
  readonly credentials?: StorageCredentials;
}

/** Reads a `PATCH` body, or answers why it is refused. */
function patchRequest(
  body: Record<string, unknown>,
): PatchRequest | "invalid_request" | "invalid_account_id" | "invalid_bucket" {
  const { name, defaultNewUsers, accountId, bucket, accessKeyId, secretAccessKey } = body;
  if (
    (name !== undefined && typeof name !== "string") ||
    (defaultNewUsers !== undefined && typeof defaultNewUsers !== "boolean") ||
    (accountId !== undefined && typeof accountId !== "string") ||
    (bucket !== undefined && typeof bucket !== "string") ||
    (accessKeyId !== undefined && typeof accessKeyId !== "string") ||
    (secretAccessKey !== undefined && typeof secretAccessKey !== "string")
  ) {
    return "invalid_request";
  }
  if (
    name === undefined &&
    defaultNewUsers === undefined &&
    accountId === undefined &&
    bucket === undefined &&
    accessKeyId === undefined &&
    secretAccessKey === undefined
  ) {
    return "invalid_request";
  }
  // The two keys come together, or not at all.
  if ((accessKeyId === undefined) !== (secretAccessKey === undefined)) {
    return "invalid_request";
  }

  const request: { -readonly [K in keyof PatchRequest]: PatchRequest[K] } = {};
  if (name !== undefined) {
    const libraryName = acceptableLibraryName(name);
    if (libraryName === null) {
      return "invalid_request";
    }
    request.name = libraryName;
  }
  if (defaultNewUsers !== undefined) {
    request.defaultNewUsers = defaultNewUsers;
  }
  if (accountId !== undefined) {
    if (!isAccountId(accountId)) {
      return "invalid_account_id";
    }
    request.accountId = accountId;
  }
  if (bucket !== undefined) {
    if (!isBucketName(bucket)) {
      return "invalid_bucket";
    }
    request.bucket = bucket;
  }
  if (accessKeyId !== undefined && secretAccessKey !== undefined) {
    const credentials = keyPair(accessKeyId, secretAccessKey);
    if (credentials === null) {
      return "invalid_request";
    }
    request.credentials = credentials;
  }

  return request;
}

/**
 * A connected library's new connection, tested: the new token, or the stored
 * one when only the account or bucket changes, against the bucket it names,
 * and on success the columns to write, the token sealed for the new path.
 * A stored token that does not open fails as `auth`.
 */
async function reconnect(
  passphrase: string,
  row: Library,
  to: {
    readonly endpoint: string;
    readonly bucket: string;
    readonly path: string;
    readonly credentials: StorageCredentials | undefined;
  },
): Promise<
  { readonly ok: true; readonly changes: LibraryChanges } | Extract<ConnectionResult, { ok: false }>
> {
  let credentials: StorageCredentials;
  try {
    credentials = to.credentials ?? (await openStored(passphrase, row));
  } catch {
    return { ok: false, reason: "auth" };
  }

  const { endpoint, bucket, path } = to;
  const tested = await testConnection(
    s3Storage({ libraryId: row.id, endpoint, bucket, path }, credentials),
  );
  if (!tested.ok) {
    return tested;
  }

  return {
    ok: true,
    changes: {
      path,
      endpoint,
      bucket,
      credentials: await sealCredentials(passphrase, path, credentials),
      writable: tested.writable,
    },
  };
}

/** A connected library's stored token, opened under its own path. Throws when it does not open. */
function openStored(passphrase: string, row: Library): Promise<StorageCredentials> {
  if (row.credentials === null) {
    return Promise.reject(new Error(`library ${row.id} has no stored credentials`));
  }
  return openCredentials(passphrase, row.path, row.credentials);
}

/**
 * A library as the console sees it. A connected library's Access Key ID hint
 * comes from its stored token, opened here (one AES-GCM decrypt), or from the
 * token just given; the secret is never read into the answer.
 */
async function viewOf(
  env: Env,
  row: Library,
  counts: LibraryCounts,
  given?: StorageCredentials,
): Promise<LibraryView> {
  const bound = row.kind === "r2-binding";
  let accessKeyIdHint: string | null = null;
  if (!bound) {
    const credentials =
      given ?? (await openStored(env.PASSWORD_ENCRYPTION_KEY ?? "", row).catch(() => null));
    accessKeyIdHint = credentials === null ? null : `…${credentials.accessKeyId.slice(-4)}`;
  }

  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    accountId: bound ? setting(env.CF_ACCOUNT_ID) : accountOf(row.endpoint),
    bucket: bound ? setting(env.R2_BUCKET_NAME) : row.bucket,
    accessKeyIdHint,
    writable: row.writable,
    defaultNewUsers: row.defaultNewUsers,
    state: row.state,
    lastScanStartedAt: row.lastScanStartedAt?.toISOString() ?? null,
    lastScanAt: row.lastScanAt?.toISOString() ?? null,
    lastScanError: row.lastScanError,
    counts,
  };
}

/** A setting, trimmed, or null when unset or empty. */
function setting(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

/**
 * Pokes the scan driver after a library was connected, moved or marked for
 * removal, and answers what the poke did, or null when the driver could not
 * be told. The library is written either way, and the next cron pass, at
 * most a quarter of an hour away, scans it.
 */
async function poke(env: Env): Promise<PokeOutcome | null> {
  try {
    return await pokeScanDriver(env);
  } catch (error) {
    console.error("admin api: the scan driver could not be poked; the cron catches up", error);
    return null;
  }
}
