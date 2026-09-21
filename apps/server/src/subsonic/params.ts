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

/** Whole numbers in base 10, as Go's `strconv.ParseInt` spells them. */
const INTEGER = /^[+-]?\d+$/;

/** The range of a Go `int64`; `ParseInt` fails outside it. */
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * A value as Go's `strconv.ParseInt(value, 10, 64)` reads it, or `null` where
 * that call would fail — anything that is not a whole decimal number, and
 * anything outside the range of an `int64`.
 *
 * Navidrome's parameter helpers all bottom out in that call, and *which*
 * values it rejects is load-bearing: a `musicFolderId` it cannot read is
 * silently dropped rather than refused, and an `ifModifiedSince` it cannot
 * read means "no condition". A `bigint` comes back rather than a `number`
 * because an `int64` runs past what a JavaScript number holds exactly, and a
 * far-future instant must stay in the future rather than rounding.
 */
export function parseGoInt64(value: string): bigint | null {
  if (!INTEGER.test(value)) {
    return null;
  }

  const parsed = BigInt(value);

  return parsed < INT64_MIN || parsed > INT64_MAX ? null : parsed;
}

/**
 * Reads an integer parameter, falling back when it is absent *or* not an
 * integer.
 *
 * Both cases share one answer because Navidrome's `req.Params.IntOr` swallows
 * either error and returns the default (utils/req/req.go). That is what makes
 * `size=lots` a list of ten albums rather than a failed sync, and a client that
 * sends a stray parameter is not worth breaking over.
 *
 * The result is a `number`, as Go narrows this one to `int`: a size, an offset
 * or a year that has passed `parseGoInt64` is far inside what a JavaScript
 * number holds exactly.
 */
export function integerParameterOr(
  params: URLSearchParams,
  name: string,
  fallback: number,
): number {
  const value = params.get(name);
  const parsed = value === null ? null : parseGoInt64(value);

  return parsed === null ? fallback : Number(parsed);
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
  const parsed = parseGoInt64(value);
  if (parsed === null) {
    throw new SubsonicError(
      SubsonicErrorCode.Generic,
      `invalid parameter '${name}': expected integer, got '${value}'`,
    );
  }

  return Number(parsed);
}
