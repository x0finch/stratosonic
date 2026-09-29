import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";

/**
 * Reading the JSON body of a console request.
 *
 * The routes that take one are small forms (a token, a name, two passwords),
 * and some of them answer before anyone has signed in, so a body is capped
 * before it is parsed: parsing an arbitrarily large one would spend the
 * request's 10 ms of CPU on a stranger's input. Navidrome caps its login and
 * first-admin bodies the same way (server/auth.go, `MaxLoginBodySize`, 8 KiB).
 */

/** The largest body a console form may send. */
export const MAX_JSON_BODY_BYTES = 8 * 1024;

/**
 * Refuses a body over `MAX_JSON_BODY_BYTES` with
 * `413 {"error":"payload_too_large"}`, by its `Content-Length` or, without
 * one, as it is read.
 */
export const limitJsonBody = bodyLimit({
  maxSize: MAX_JSON_BODY_BYTES,
  onError: (c) => c.json({ error: "payload_too_large" }, 413),
});

/**
 * The request's body as a JSON object, or `null` when it is not one: not
 * JSON at all, or JSON of another shape (an array, a string, `null`).
 */
export async function readJsonObject(c: Context): Promise<Record<string, unknown> | null> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return null;
  }

  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/** Answers `400 {"error":"invalid_request"}`: a body the route cannot read. */
export function invalidRequest(c: Context) {
  return c.json({ error: "invalid_request" }, 400);
}
