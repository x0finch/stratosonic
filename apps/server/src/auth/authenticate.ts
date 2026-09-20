import { database } from "../db";
import type { Env } from "../env";
import { SubsonicError, SubsonicErrorCode } from "../subsonic/response";
import { findUserByUsername } from "../users/repository";
import { constantTimeEquals, decodeHex, decryptPassword, subsonicToken } from "./crypto";

/**
 * Subsonic authentication, following Navidrome's `checkRequiredParameters` and
 * `authenticate`/`validateCredentials` middlewares
 * (server/subsonic/middlewares.go).
 */

/** Who the request is from, as endpoints see it. */
export interface AuthenticatedUser {
  readonly id: string;
  readonly userName: string;
  readonly isAdmin: boolean;
}

/**
 * Every authenticated endpoint needs these: the username, the client's protocol
 * version, and the client's name.
 */
const REQUIRED_PARAMETERS = ["u", "v", "c"] as const;

/**
 * Rejects a request that is missing a required parameter, before any
 * credentials are looked at — the order Navidrome checks them in, so a client
 * that forgets `c` is told that rather than "wrong username or password".
 */
export function checkRequiredParameters(params: URLSearchParams): void {
  for (const name of REQUIRED_PARAMETERS) {
    if (!params.get(name)) {
      throw new SubsonicError(SubsonicErrorCode.MissingParameter, `missing parameter: '${name}'`);
    }
  }
}

/**
 * Identifies the user behind a request, or throws error 40.
 *
 * Every failure — unknown user, undecryptable password, wrong token — is the
 * same error to the client, so a caller cannot use the response to learn which
 * usernames exist.
 */
export async function authenticate(env: Env, params: URLSearchParams): Promise<AuthenticatedUser> {
  const found = await findUserByUsername(database(env), params.get("u") ?? "");
  if (!found) {
    throw authenticationFailed();
  }

  const password = await storedPassword(env, found.password);
  if (password === null || !(await credentialsMatch(params, password))) {
    throw authenticationFailed();
  }

  return { id: found.id, userName: found.userName, isAdmin: found.isAdmin };
}

function authenticationFailed(): SubsonicError {
  return new SubsonicError(SubsonicErrorCode.AuthenticationFailed);
}

/** Whether this isolate has already reported the missing encryption key. */
let warnedAboutMissingKey = false;

/**
 * Recovers a user's password. A password this server cannot read — because
 * `PASSWORD_ENCRYPTION_KEY` is unset or has changed — is a server-side problem
 * the client cannot fix, so it is logged and the login simply fails.
 */
async function storedPassword(env: Env, stored: string): Promise<string | null> {
  if (!env.PASSWORD_ENCRYPTION_KEY) {
    if (!warnedAboutMissingKey) {
      // A missing secret does not come back on its own, so saying it once per
      // isolate is enough; saying it per request would bury the logs.
      warnedAboutMissingKey = true;
      console.error("PASSWORD_ENCRYPTION_KEY is not set; no user can log in");
    }
    return null;
  }

  try {
    return await decryptPassword(env.PASSWORD_ENCRYPTION_KEY, stored);
  } catch (error) {
    console.error("could not decrypt a stored password", error);
    return null;
  }
}

/**
 * Checks the credentials in the request against the user's password, in
 * Navidrome's order: the `p` parameter wins over a token when a client sends
 * both.
 */
async function credentialsMatch(params: URLSearchParams, password: string): Promise<boolean> {
  const supplied = params.get("p");
  if (supplied) {
    return constantTimeEquals(plaintextPassword(supplied), password);
  }

  const token = params.get("t");
  if (token) {
    // Tokens are hex, and a client is free to send it in either case; the
    // digest we compute is lowercase.
    return constantTimeEquals(
      await subsonicToken(password, params.get("s") ?? ""),
      token.toLowerCase(),
    );
  }

  return false;
}

/**
 * Reads the `p` parameter. Clients may hex-encode it behind an `enc:` prefix;
 * as in Navidrome, a prefix whose payload is not hex is left alone rather than
 * treated as an error, so such a password is simply wrong.
 */
function plaintextPassword(supplied: string): string {
  if (!supplied.startsWith("enc:")) {
    return supplied;
  }

  return decodeHex(supplied.slice("enc:".length)) ?? supplied;
}
