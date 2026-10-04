import type { Env } from "../env";
import { listingFailure } from "../scanner/listing-failure";
import { r2Endpoint } from "../storage/presign";
import { R2_ENDPOINT } from "../storage/s3";
import { type LibraryStorage, StorageError, type StorageFailure } from "../storage/storage";

/**
 * Connecting a bucket as a library (#84, "Libraries API"): what its fields
 * must be, and the connection test that proves a token reaches it.
 */

/** The longest library name, trimmed. */
export const MAX_LIBRARY_NAME_LENGTH = 64;

/** The longest Access Key ID or Secret Access Key taken: R2's are 32 and 64 characters. */
export const MAX_KEY_LENGTH = 256;

/** A Cloudflare account id: 32 lowercase hex characters. */
const ACCOUNT_ID = /^[0-9a-f]{32}$/;

/** R2's bucket names: 3-63 of `a-z 0-9 -`, starting and ending with a letter or digit. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * The object the write probe puts and deletes. The leading dot hides it from
 * the scan and the Files page's rules, as Navidrome skips hidden files.
 */
export const WRITE_PROBE_KEY = ".stratosonic-write-check";

/** A name as stored: trimmed, 1-64 characters, or null. */
export function acceptableLibraryName(typed: string): string | null {
  const name = typed.trim();
  return name.length >= 1 && name.length <= MAX_LIBRARY_NAME_LENGTH ? name : null;
}

export function isAccountId(value: string): boolean {
  return ACCOUNT_ID.test(value);
}

export function isBucketName(value: string): boolean {
  return BUCKET_NAME.test(value);
}

/** A key as stored: trimmed, 1-`MAX_KEY_LENGTH` characters, or null. */
export function acceptableKey(typed: string): string | null {
  const key = typed.trim();
  return key.length >= 1 && key.length <= MAX_KEY_LENGTH ? key : null;
}

/** The account id an R2 endpoint names, or null for any other endpoint. */
export function accountOf(endpoint: string | null): string | null {
  if (endpoint === null || !R2_ENDPOINT.test(endpoint)) {
    return null;
  }
  return endpoint.slice("https://".length, "https://".length + 32);
}

/** The bucket's S3 endpoint: always an account's R2 endpoint, and nothing else. */
export function endpointOf(accountId: string): string {
  return r2Endpoint(accountId);
}

/**
 * Whether this is the bucket the Worker is bound to (`CF_ACCOUNT_ID` and
 * `R2_BUCKET_NAME`): library 1, which cannot be connected a second time.
 */
export function isBoundBucket(env: Env, accountId: string, bucket: string): boolean {
  return env.CF_ACCOUNT_ID?.trim() === accountId && env.R2_BUCKET_NAME?.trim() === bucket;
}

/** What a connection test found. */
export type ConnectionResult =
  | { readonly ok: true; readonly writable: boolean }
  | { readonly ok: false; readonly reason: StorageFailure };

/**
 * Tests a library's bucket with its token (#84, "Libraries API"), in at
 * most three requests:
 *
 * 1. `ListObjectsV2` of one key proves the endpoint, the bucket and read
 *    access, or fails with `auth`, `bucket_not_found` or another reason;
 * 2. a write probe, `PutObject` of an empty `WRITE_PROBE_KEY` with
 *    `If-None-Match: *`: a refusal of the token (`auth`, a 403) means the
 *    token is read-only, which is allowed, as Navidrome allows a read-only
 *    music folder. A 412 means a test that crashed left its probe, which
 *    still proves write access;
 * 3. the probe's delete.
 *
 * Any other failure of the probe fails the test with its reason.
 */
export async function testConnection(storage: LibraryStorage): Promise<ConnectionResult> {
  try {
    await storage.list({ limit: 1 });
  } catch (error) {
    return { ok: false, reason: listingFailure(error) };
  }

  try {
    // Null is the leftover probe (412): written by an earlier test, and
    // deleted here as this one's would be.
    await storage.put(WRITE_PROBE_KEY, new Uint8Array(0), { onlyIfAbsent: true });
  } catch (error) {
    if (error instanceof StorageError && error.reason === "auth") {
      return { ok: true, writable: false };
    }
    return { ok: false, reason: listingFailure(error) };
  }

  try {
    await storage.delete([WRITE_PROBE_KEY]);
  } catch (error) {
    return { ok: false, reason: listingFailure(error) };
  }

  return { ok: true, writable: true };
}
