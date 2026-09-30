import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import { type ConsoleAuth, consoleAuth, isUnauthorizedError } from "./auth";
import { type Permission, roleGrants } from "./permissions";

/**
 * The console API's view of Better Auth (#81, #89): the middleware that
 * provides it, and the middleware later tickets guard their routes with.
 *
 * The instance is built on the first `/api` request an isolate serves for an
 * origin, and only there, so the Subsonic API, the public image URLs, the cron
 * and the scan driver's alarm never build one (console-auth/auth.ts).
 */

/**
 * Who a console request is from, as a route sees it: a console user, the
 * console's own kind of account (#99), and the role that says what they may
 * do (console-auth/permissions.ts).
 */
export interface ConsoleSession {
  /** Better Auth's session id: what `setConsolePassword`'s `keepSessionId` names. */
  readonly id: string;
  /** The console user's id, in `user`. */
  readonly userId: string;
  /** The name as entered, `display_username`. */
  readonly username: string;
  /**
   * `user.role` as stored, which may be one this release does not know
   * and so grants nothing. As fresh as the check that read it: the cookie
   * cache's for `requireSession`, D1's for `requireFreshSession`.
   */
  readonly role: string;
}

/**
 * What every route under `/api` has: the Worker's bindings, Better Auth, and
 * `PASSWORD_ENCRYPTION_KEY`, which the middleware has checked is set, for the
 * routes that hand it to the credential writer.
 */
export interface ConsoleEnv {
  Bindings: Env;
  Variables: { consoleAuth: ConsoleAuth; passphrase: string };
}

/** What a route behind `requireSession` or `requireFreshSession` has as well. */
export interface SessionEnv extends ConsoleEnv {
  Variables: ConsoleEnv["Variables"] & { session: ConsoleSession };
}

/** Whether this isolate has already reported the missing encryption key. */
let warnedAboutMissingKey = false;

/**
 * The hosts a plain-http origin may have: the local `wrangler dev` a developer
 * runs the console on (`URL.hostname` keeps IPv6 in brackets).
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether an origin is one the console's sessions may live on. Its scheme
 * decides the cookies (console-auth/auth.ts): over plain http they could not
 * be `__Secure-` or `Secure`, and would travel in the clear, so outside a
 * loopback address only https will do. A Worker answers plain http too, on
 * `workers.dev` and on a custom domain without "Always Use HTTPS".
 */
function isSecureOrigin(url: URL): boolean {
  return url.protocol === "https:" || LOOPBACK_HOSTNAMES.has(url.hostname);
}

/**
 * Provides the isolate's Better Auth instance for the request's origin, or
 * answers `503 {"error":"not_configured"}` without `PASSWORD_ENCRYPTION_KEY`:
 * the console can neither sign a session nor read a password without it, and
 * a secret derived from an empty passphrase would be one anybody can compute
 * (#81). The Subsonic API has the same dependency and fails its logins
 * instead (auth/authenticate.ts). A plain-http origin other than a loopback
 * address answers `403 {"error":"insecure_origin"}`, and builds nothing.
 */
export const loadConsoleAuth = createMiddleware<ConsoleEnv>(async (c, next) => {
  const passphrase = c.env.PASSWORD_ENCRYPTION_KEY;
  if (!passphrase) {
    if (!warnedAboutMissingKey) {
      warnedAboutMissingKey = true;
      console.warn("admin api: PASSWORD_ENCRYPTION_KEY is not set; every /api route answers 503");
    }
    return c.json({ error: "not_configured" }, 503);
  }

  const url = new URL(c.req.url);
  if (!isSecureOrigin(url)) {
    return c.json({ error: "insecure_origin" }, 403);
  }

  c.set("consoleAuth", await consoleAuth({ db: c.env.DB, passphrase, origin: url.origin }));
  c.set("passphrase", passphrase);

  await next();
});

/**
 * Requires a signed-in console user, trusting the cookie cache: within its 5
 * minutes a check makes no D1 query at all. For reads, which may be that
 * stale (#81).
 */
export const requireSession = createMiddleware<SessionEnv>(async (c, next) => {
  const session = await readSession(c, { fresh: false });
  if (!session) {
    return unauthenticated(c);
  }

  c.set("session", session);
  await next();
});

/**
 * Requires a signed-in console user, read from D1 past the cookie cache: the
 * session row and its console user as they are now, so a revoked session is
 * refused at once. For every route that writes (#81).
 */
export const requireFreshSession = createMiddleware<SessionEnv>(async (c, next) => {
  const session = await readSession(c, { fresh: true });
  if (!session) {
    return unauthenticated(c);
  }

  c.set("session", session);
  await next();
});

/**
 * Requires the console user's role to grant `permission`, answering
 * `403 {"error":"forbidden"}` otherwise. It goes after `requireSession`, whose
 * role the cookie cache may vouch for up to 5 minutes, which is as stale as a
 * read may be, or, for a write, after `requireFreshSession`, whose role is
 * read from D1, so a role taken away stops the next write.
 *
 * Routes ask for a permission, never for a role by name, so that a new role
 * is a change to console-auth/permissions.ts and to no route.
 */
export function requirePermission(permission: Permission) {
  return createMiddleware<SessionEnv>(async (c, next) => {
    if (!roleGrants(c.var.session.role, permission)) {
      return c.json({ error: "forbidden" }, 403);
    }

    await next();
  });
}

function getSession(auth: ConsoleAuth, headers: Headers, fresh: boolean) {
  return auth.api.getSession({
    headers,
    query: { disableCookieCache: fresh },
    returnHeaders: true,
  });
}

/** Passes on the cookies Better Auth set, when it set any. */
function forwardCookies(c: Context, headers: unknown): void {
  if (!(headers instanceof Headers)) {
    return;
  }
  for (const cookie of headers.getSetCookie()) {
    c.header("Set-Cookie", cookie, { append: true });
  }
}

function unauthenticated(c: Context) {
  return c.json({ error: "unauthenticated" }, 401);
}

/**
 * The request's session, through `auth.api.getSession` rather than an HTTP
 * round trip to `/api/auth/get-session` (#86: 0.8 ms of CPU against 1.5 ms).
 *
 * The cookies Better Auth sets while it checks are passed on to the response:
 * a re-cached `session_data` after the cache runs out, a refreshed
 * `session_token` after `updateAge`, or cleared cookies for a session that is
 * gone. Dropping them would leave the browser without a cache, and every later
 * check would read D1 again.
 */
async function readSession(
  c: Context<SessionEnv>,
  { fresh }: { fresh: boolean },
): Promise<ConsoleSession | null> {
  let checked: Awaited<ReturnType<typeof getSession>>;
  try {
    checked = await getSession(c.var.consoleAuth, c.req.raw.headers, fresh);
  } catch (error) {
    // The session went while it was being checked: no session, like any
    // other, rather than the error handler's 500.
    if (isUnauthorizedError(error)) {
      forwardCookies(c, error.headers);
      return null;
    }
    throw error;
  }

  const { headers, response } = checked;
  forwardCookies(c, headers);
  if (!response) {
    return null;
  }

  return {
    id: response.session.id,
    userId: response.user.id,
    // The plugin types `displayUsername` as optional; the column is never
    // null.
    username: response.user.displayUsername ?? response.user.name,
    // Better Auth types the field as optional; a row always has one, and a
    // missing one would grant nothing.
    role: response.user.role ?? "",
  };
}
