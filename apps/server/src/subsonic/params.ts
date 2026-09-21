import { SubsonicError, SubsonicErrorCode } from "./response";

/**
 * Reads a parameter an endpoint cannot work without.
 *
 * A missing one is error 10 with Navidrome's wording — its `req.Params.String`
 * builds `missing parameter: '<name>'` (utils/req/req.go) — so a client sees
 * the same message from both servers.
 */
export function requiredParameter(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (!value) {
    throw new SubsonicError(SubsonicErrorCode.MissingParameter, `missing parameter: '${name}'`);
  }

  return value;
}

/** What Go's `strconv.ParseInt(s, 10, 64)` accepts: an optional sign and digits. */
const INTEGER = /^[+-]?\d+$/;

/**
 * Reads an integer parameter, falling back when it is absent *or* not an
 * integer.
 *
 * Both cases share one answer because Navidrome's `req.Params.IntOr` swallows
 * either error and returns the default (utils/req/req.go). That is what makes
 * `size=lots` a list of ten albums rather than a failed sync, and a client that
 * sends a stray parameter is not worth breaking over.
 */
export function integerParameterOr(
  params: URLSearchParams,
  name: string,
  fallback: number,
): number {
  const value = params.get(name);

  return value !== null && INTEGER.test(value) ? Number(value) : fallback;
}

/**
 * Reads an integer parameter an endpoint cannot work without.
 *
 * Absent and unparseable are different failures here, as they are in
 * Navidrome: `req.Params.Int` returns `ErrMissingParam` for the first and
 * `ErrInvalidParam` for the second, and `mapToSubsonicError`
 * (server/subsonic/api.go) turns those into error 10 and error 0 respectively,
 * each carrying the wording built here.
 */
export function requiredIntegerParameter(params: URLSearchParams, name: string): number {
  const value = requiredParameter(params, name);
  if (!INTEGER.test(value)) {
    throw new SubsonicError(
      SubsonicErrorCode.Generic,
      `invalid parameter '${name}': expected integer, got '${value}'`,
    );
  }

  return Number(value);
}
