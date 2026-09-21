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

/** The shape Go's `strconv.ParseInt(s, 10, 64)` accepts: a sign and digits. */
const INTEGER = /^[+-]?\d+$/;

/** And the range it accepts, beyond which it reports the value out of range. */
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * The number this text denotes, or `null` when Go would not have parsed it.
 *
 * The bound matters as much as the shape: a twenty-digit `toYear` is a value
 * `strconv.ParseInt` rejects, and without the check it would arrive here as a
 * rounded 1e20 and quietly become a year range nothing falls in. What is left
 * after the check fits comfortably in a JavaScript number for every parameter
 * the protocol has, so the value is returned as one, as Go narrows it to `int`.
 */
function parseInteger(value: string): number | null {
  if (!INTEGER.test(value)) {
    return null;
  }

  const parsed = BigInt(value);

  return parsed < INT64_MIN || parsed > INT64_MAX ? null : Number(parsed);
}

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
  const parsed = value === null ? null : parseInteger(value);

  return parsed ?? fallback;
}

/**
 * Reads an integer parameter an endpoint cannot work without.
 *
 * Absent and unparseable are different failures here, as they are in
 * Navidrome: `req.Params.Int` returns `ErrMissingParam` for the first and
 * `ErrInvalidParam` for the second, and `mapToSubsonicError`
 * (server/subsonic/api.go) turns those into error 10 and error 0 respectively,
 * each carrying the wording built here. A value Go would call out of range is
 * unparseable too, and `Int64` wraps every `ParseInt` failure in that one
 * message, so it reads the same as a value that was never a number.
 */
export function requiredIntegerParameter(params: URLSearchParams, name: string): number {
  const value = requiredParameter(params, name);
  const parsed = parseInteger(value);
  if (parsed === null) {
    throw new SubsonicError(
      SubsonicErrorCode.Generic,
      `invalid parameter '${name}': expected integer, got '${value}'`,
    );
  }

  return parsed;
}
