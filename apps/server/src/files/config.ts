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
