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
