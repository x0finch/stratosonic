import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";

/**
 * Reading the JSON body of a console request.
 *
 * The routes that take one are small forms (a token, a name, two passwords),
 * and some of them answer before anyone has signed in, so a body is capped
 * before it is parsed: parsing an arbitrarily large one would spend the
 * request's 10 ms of CPU on a stranger's input. Navidrome caps its login and
 * first-admin bodies the same way (server/auth.go, `MaxLoginBodySize`).
 */

/**
 * The largest body a console form may send. Navidrome's cap is 8 KiB, but a
 * password may be `MAX_PASSWORD_LENGTH` (1,024) UTF-16 units, and JSON may
 * escape each as `\uXXXX`, six bytes: a password change carrying two such
 * passwords is about 12 KiB. 16 KiB takes that with room to spare, and is
 * still nothing to parse.
 */
export const MAX_JSON_BODY_BYTES = 16 * 1024;

/**
 * Refuses a body over `MAX_JSON_BODY_BYTES` with
 * `413 {"error":"payload_too_large"}`, by its `Content-Length` or, without
 * one, as it is read.
 */
export const limitJsonBody = bodyLimit({
  maxSize: MAX_JSON_BODY_BYTES,
  onError: payloadTooLarge,
});

/**
 * The largest body of `POST /api/files/delete` (#83, "Permissions"): its 250
 * keys of up to 1,024 bytes each are 250 KiB, and JSON may escape a key's
 * characters, so twice that leaves room. Still nothing to parse.
 */
export const MAX_FILE_DELETE_BODY_BYTES = 512 * 1024;

/** `limitJsonBody` for that one route, with the same answer. */
export const limitFileDeleteBody = bodyLimit({
  maxSize: MAX_FILE_DELETE_BODY_BYTES,
  onError: payloadTooLarge,
});

/**
 * The largest body of `POST /api/files/uploads/check` (#141): its 1,000 keys
 * of up to 1,024 bytes each are 1 MiB, and JSON may escape a key's
 * characters, so twice that leaves room, as the delete's cap does.
 */
export const MAX_FILE_CHECK_BODY_BYTES = 2 * 1024 * 1024;

/** `limitJsonBody` for the upload check, with the same answer. */
export const limitFileCheckBody = bodyLimit({
  maxSize: MAX_FILE_CHECK_BODY_BYTES,
  onError: payloadTooLarge,
});

function payloadTooLarge(c: Context) {
  return c.json({ error: "payload_too_large" }, 413);
}

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
