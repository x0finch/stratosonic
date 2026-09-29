import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

/**
 * Cross-site request forgery protection for the console's own state-changing
 * routes (#81): every `/api` route that writes, and is not one of Better
 * Auth's, goes behind `requireSameOrigin`. Better Auth checks the `Origin` of
 * its own routes against its trusted origins, but that check covers only the
 * requests it serves.
 *
 * Two conditions, each enough on its own against a browser, and both
 * required:
 *
 * - The body is `application/json`. An HTML form cannot send that, and a
 *   cross-origin `fetch` that does is preflighted, which the Worker never
 *   answers with CORS headers, so the browser never sends it.
 * - The `Origin` header is the request's own origin, and `Sec-Fetch-Site`,
 *   when the browser sends it, says `same-origin`. Browsers send `Origin` on
 *   every POST, same-origin ones included; a request without one is refused,
 *   so a script driving these routes (curl, say) has to name the origin too.
 *
 * Anything else answers `403 {"error":"forbidden_origin"}` before the route
 * reads the body or D1.
 */
export const requireSameOrigin = createMiddleware(async (c, next) => {
  if (!isJson(c.req.header("content-type")) || !isSameOrigin(c)) {
    return c.json({ error: "forbidden_origin" }, 403);
  }

  await next();
});

/** Whether a `Content-Type` is JSON, whatever parameters (`charset`) it has. */
function isJson(contentType: string | undefined): boolean {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

function isSameOrigin(c: Context): boolean {
  const fetchSite = c.req.header("sec-fetch-site");
  if (fetchSite !== undefined && fetchSite !== "same-origin") {
    return false;
  }

  // An opaque origin serializes as "null", which is never the request's own.
  return c.req.header("origin") === new URL(c.req.url).origin;
}
