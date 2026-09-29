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
  return integerParameterValue(name, requiredParameter(params, name));
}

/**
 * Reads one already-held value of an integer parameter, refusing what Go's
 * `ParseInt` refuses.
 *
 * `requiredIntegerParameter` is this plus the presence check; a repeatable
 * parameter such as `scrobble`'s `time` cannot use that one — a request
 * carries several values, and `URLSearchParams.get` would only ever see the
 * first — so the refusal lives here, where both reach it and a client sees the
 * same error 0 and the same wording whichever parameter it was.
 */
export function integerParameterValue(name: string, value: string): number {
  const parsed = parseGoInt64(value);
  if (parsed === null) {
    throw new SubsonicError(
      SubsonicErrorCode.Generic,
      `invalid parameter '${name}': expected integer, got '${value}'`,
    );
  }

  return Number(parsed);
}

/** A decimal float as Go's `strconv.ParseFloat` spells one. */
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** The words `ParseFloat` also reads, in any case: infinities and NaN. */
const FLOAT_WORD = /^([+-]?)(inf|infinity|nan)$/i;

/**
 * Reads a float parameter, falling back when it is absent or not a float -
 * Navidrome's `req.Params.Float64Or`, which swallows the `ParseFloat` error.
 *
 * What `ParseFloat` accepts that is not a finite number comes back as it
 * reads it: `NaN`, `Inf` and `-Infinity` are floats to Go, so a caller that
 * wants a finite value has to refuse them itself, as Navidrome's
 * `reportPlayback` does. A decimal too large for a float64 is a range error
 * to Go, and so the fallback here. Go's hexadecimal floats are not read.
 */
export function floatParameterOr(params: URLSearchParams, name: string, fallback: number): number {
  const value = params.get(name);
  if (!value) {
    return fallback;
  }

  const word = FLOAT_WORD.exec(value);
  if (word) {
    if (word[2]?.toLowerCase() === "nan") {
      return Number.NaN;
    }

    return word[1] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }

  const parsed = FLOAT.test(value) ? Number(value) : Number.NaN;

  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Reads a boolean parameter as Navidrome's `req.Params.BoolOr` does: absent
 * or empty is the fallback, `true`, `on` and `1` in any case are true, and
 * anything else is false.
 */
export function booleanParameterOr(
  params: URLSearchParams,
  name: string,
  fallback: boolean,
): boolean {
  const value = params.get(name);
  if (!value) {
    return fallback;
  }

  return ["true", "on", "1"].includes(value.toLowerCase());
}
