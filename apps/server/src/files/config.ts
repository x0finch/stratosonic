import { createMiddleware } from "hono/factory";
import type { Env } from "../env";

/**
 * What the Files page is configured to do (#83, "Configuration"), from the
 * Worker's environment (env.ts).
 *
 * ## The preview switch (owner decision 2)
 *
 * The preview environment binds the production bucket, so a preview console
 * could delete production files. `FILE_WRITES = "off"`, set in wrangler.jsonc's
 * `env.preview.vars`, makes the Files page read-only there: every route that
 * changes the bucket goes behind `requireFileWrites`, and
 * `GET /api/files/config` reports `writes.enabled: false`, so the console
 * hides the write controls. Production leaves the var unset.
 *
 * ## Uploads
 *
 * The browser uploads straight to the bucket's S3 endpoint, with URLs the
 * Worker presigns (storage/presign.ts) with an R2 API token. Uploads are
 * configured only when the token's two secrets, `CF_ACCOUNT_ID` and
 * `R2_BUCKET_NAME` are all set (`uploadsStatus`); otherwise
 * `GET /api/files/config` reports `uploads.configured: false` with the
 * missing names, and `POST /api/files/uploads` answers
 * `503 {"error":"uploads_not_configured"}`.
 */

/**
 * Whether the Files page may change the bucket: everywhere but where
 * `FILE_WRITES` is `"off"` (case and surrounding spaces ignored). Any other
 * value, or none, leaves writes on, so a typo cannot lock production out.
 */
export function fileWritesEnabled(env: Env): boolean {
  return env.FILE_WRITES?.trim().toLowerCase() !== "off";
}

/**
 * Refuses a request with `403 {"error":"file_writes_disabled"}` where file
 * writes are off, before it reads its body, R2, D1 or the scan driver. It goes
 * last in a write route's chain, after `requirePermission`, so a request that
 * is not allowed to write at all is told so first; every file write route
 * takes it unchanged.
 */
export const requireFileWrites = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  if (!fileWritesEnabled(c.env)) {
    return c.json({ error: "file_writes_disabled" }, 403);
  }

  await next();
});

/* ---------------------------------------------------------- uploads -- */

/**
 * The values uploads need (#83, "Configuration"), in the order
 * `GET /api/files/config` names the missing ones: the R2 API token's two
 * secrets, the account id the S3 endpoint is built from (the usage panel's
 * own secret, reused), and the bucket's name, a var in wrangler.jsonc that
 * must equal the `MUSIC` binding's `bucket_name`.
 */
export const UPLOAD_SETTINGS = [
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "CF_ACCOUNT_ID",
  "R2_BUCKET_NAME",
] as const;

export type UploadSetting = (typeof UPLOAD_SETTINGS)[number];

/** What presigning an upload needs, every value trimmed and present. */
export interface UploadsConfig {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly accountId: string;
  readonly bucket: string;
}

/**
 * Whether uploads are configured: all four values present, or which are
 * missing. `missing` names the values, never their contents.
 */
export type UploadsStatus =
  | { readonly configured: true; readonly config: UploadsConfig }
  | { readonly configured: false; readonly missing: readonly UploadSetting[] };

/** Whether this isolate has reported a token set without the rest. */
let warnedAboutPartialUploads = false;

/**
 * The upload settings from the environment, each trimmed, with an empty
 * value counted as unset (as a `.dev.vars` line `R2_ACCESS_KEY_ID = ""`
 * leaves it).
 *
 * It warns once per isolate, as the usage panel does, when the token's own
 * values are present, one or both, but not all four are: the bucket's name
 * is always set by wrangler.jsonc, and the account id by the usage panel, so
 * either alone is no attempt to configure uploads. The warning names the
 * missing values, never a value.
 */
export function uploadsStatus(env: Env): UploadsStatus {
  const values: Record<UploadSetting, string | null> = {
    R2_ACCESS_KEY_ID: setting(env.R2_ACCESS_KEY_ID),
    R2_SECRET_ACCESS_KEY: setting(env.R2_SECRET_ACCESS_KEY),
    CF_ACCOUNT_ID: setting(env.CF_ACCOUNT_ID),
    R2_BUCKET_NAME: setting(env.R2_BUCKET_NAME),
  };
  const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CF_ACCOUNT_ID, R2_BUCKET_NAME } = values;
  if (
    R2_ACCESS_KEY_ID === null ||
    R2_SECRET_ACCESS_KEY === null ||
    CF_ACCOUNT_ID === null ||
    R2_BUCKET_NAME === null
  ) {
    const missing = UPLOAD_SETTINGS.filter((name) => values[name] === null);
    const tokenGiven = R2_ACCESS_KEY_ID !== null || R2_SECRET_ACCESS_KEY !== null;
    if (tokenGiven && !warnedAboutPartialUploads) {
      warnedAboutPartialUploads = true;
      console.warn(`files: uploads stay off until ${missing.join(", ")} is set as well`);
    }
    return { configured: false, missing };
  }

  return {
    configured: true,
    config: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      accountId: CF_ACCOUNT_ID,
      bucket: R2_BUCKET_NAME,
    },
  };
}

/** The bucket's name, as `GET /api/files/config` reports it, or null when unset. */
export function bucketName(env: Env): string | null {
  return setting(env.R2_BUCKET_NAME);
}

/** Forgets what this isolate has warned about. For tests. */
export function forgetUploadsWarning(): void {
  warnedAboutPartialUploads = false;
}

/** A value trimmed, or null when unset or empty. */
function setting(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}
