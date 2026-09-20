import { SubsonicError, SubsonicErrorCode } from "../subsonic/response";
import type { SubsonicHandler } from "../subsonic/router";

/**
 * The answer for an endpoint that exists in the protocol but not in this
 * server, so a client is told plainly rather than left to guess from a 404.
 *
 * Navidrome's `h501` (server/subsonic/api.go) writes this message with HTTP
 * 501; Stratosonic keeps the status and the message but wraps them in the
 * Subsonic envelope, for the reason ADR-0005 gives for unknown endpoints — a
 * client's XML or JSON parser can then read the answer and report it, instead
 * of failing on a bare text body.
 */
export const NOT_IMPLEMENTED_MESSAGE =
  "This endpoint is not implemented, but may be in future releases";

/** Answers HTTP 501 with a Subsonic error envelope carrying code 0. */
export const notImplemented: SubsonicHandler = () => {
  throw new SubsonicError(SubsonicErrorCode.Generic, NOT_IMPLEMENTED_MESSAGE, 501);
};
