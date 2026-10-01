import { requirePermission, requireSession } from "../console-auth/middleware";
import { readUsage } from "../usage/analytics";
import type { ApiApp } from "./app";

/** The console's free-tier usage panel (#82, "API: usage panel"; #117). */
export function registerUsageRoutes(api: ApiApp): void {
  /**
   * `GET /api/usage`, for a console user whose role grants `usage:read`.
   *
   * - `200 {"configured": false}` without `CF_ANALYTICS_TOKEN` and
   *   `CF_ACCOUNT_ID`: the console hides the panel;
   * - `200 {"configured": true, ...}`, today's usage of the whole Cloudflare
   *   account against the free plan's limits (usage/analytics.ts);
   * - `502 {"error": "analytics_unavailable", "reason": ...}` when
   *   Cloudflare's GraphQL API gave none: `unauthorized`, `rate_limited` or
   *   `upstream`.
   *
   * A read, so the cookie cache vouches for the session, and the answer comes
   * from the isolate's cache or one GraphQL request: no D1 at all.
   */
  api.get("/usage", requireSession, requirePermission("usage:read"), async (c) => {
    // Looked up on each call, so that a test can stand in for it.
    const answer = await readUsage(c.env, { fetch: (input, init) => fetch(input, init) });
    switch (answer.status) {
      case "unconfigured":
        return c.json({ configured: false });
      case "ok":
        return c.json(answer.report);
      case "unavailable":
        return c.json({ error: "analytics_unavailable", reason: answer.reason }, 502);
    }
  });
}
