import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import type { ConsoleAuth } from "./auth";

/**
 * The console API's view of Better Auth (#81, #89): the middleware that loads
 * it, and the middleware later tickets guard their routes with.
 *
 * Better Auth is imported here by type only. The instance comes from a dynamic
 * `import()` on the first `/api` request an isolate serves, so the Subsonic
 * API, the public image URLs, the cron and the scan driver's alarm never
 * evaluate it (console-auth/auth.ts).
 */

/** Who a console request is from, as a route sees it. */
export interface ConsoleSession {
  /** Better Auth's session id: what `setPassword`'s `keepSessionId` names. */
  readonly id: string;
  readonly userId: string;
  /** `user_name`, as entered: the name Subsonic's `getUser` answers with. */
  readonly userName: string;
  readonly isAdmin: boolean;
}

/** What every route under `/api` has: the Worker's bindings and Better Auth. */
export interface ConsoleEnv {
  Bindings: Env;
  Variables: { consoleAuth: ConsoleAuth };
}

/** What a route behind `requireSession` or `requireFreshSession` has as well. */
export interface SessionEnv extends ConsoleEnv {
  Variables: ConsoleEnv["Variables"] & { session: ConsoleSession };
}

/** Whether this isolate has already reported the missing encryption key. */
let warnedAboutMissingKey = false;

/**
 * Loads the isolate's Better Auth instance for the request's origin, or
 * answers `503 {"error":"not_configured"}` without `PASSWORD_ENCRYPTION_KEY`:
 * the console can neither sign a session nor read a password without it, and
 * a secret derived from an empty passphrase would be one anybody can compute
 * (#81). The Subsonic API has the same dependency and fails its logins
 * instead (auth/authenticate.ts).
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

  const { consoleAuth } = await import("./auth");
  c.set(
    "consoleAuth",
    await consoleAuth({ db: c.env.DB, passphrase, origin: new URL(c.req.url).origin }),
  );

  await next();
});

/**
 * Requires a signed-in user, trusting the cookie cache: within its 5 minutes a
 * check makes no D1 query at all. For reads, which may be that stale (#81).
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
 * Requires a signed-in user, read from D1 past the cookie cache: the session
 * row and the user's `is_admin` as they are now, so a revoked session or a
 * demoted admin is refused at once. For every route that writes (#81).
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
 * Requires the signed-in user to be an admin, answering
 * `403 {"error":"forbidden"}` otherwise. It goes after `requireSession` or,
 * for a write, `requireFreshSession`, whose `is_admin` it reads.
 */
export const requireAdmin = createMiddleware<SessionEnv>(async (c, next) => {
  if (!c.var.session.isAdmin) {
    return c.json({ error: "forbidden" }, 403);
  }

  await next();
});

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
  const { headers, response } = await c.var.consoleAuth.api.getSession({
    headers: c.req.raw.headers,
    query: { disableCookieCache: fresh },
    returnHeaders: true,
  });

  for (const cookie of headers.getSetCookie()) {
    c.header("Set-Cookie", cookie, { append: true });
  }

  if (!response) {
    return null;
  }

  return {
    id: response.session.id,
    userId: response.user.id,
    // The plugin types `displayUsername` as optional; it is `user_name`,
    // which is never null.
    userName: response.user.displayUsername ?? response.user.name,
    isAdmin: response.user.isAdmin === true,
  };
}
