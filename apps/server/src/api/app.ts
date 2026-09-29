import { Hono } from "hono";
import { type ConsoleEnv, loadConsoleAuth, requireSession } from "../console-auth/middleware";

/**
 * The admin console's JSON API, mounted at `/api` (#87).
 *
 * It is not part of the Subsonic protocol and never answers with the Subsonic
 * envelope: a client of `/api` is the console, which reads plain JSON and an
 * HTTP status. That holds for the paths it does not know and for a handler
 * that throws, which would otherwise fall through to the Subsonic app's own
 * not-found and error handlers.
 */
export type ApiApp = Hono<ConsoleEnv>;

/** Builds the console API. Routes are registered here, ahead of the catch-all. */
export function createApiApp(): ApiApp {
  const api: ApiApp = new Hono();

  api.onError((error, c) => {
    console.error("admin api: a handler failed", error);
    return c.json({ error: "internal" }, 500);
  });

  // Every path under `/api` needs Better Auth, or answers 503 without the key
  // it is built from. Its instance is built here, on the first `/api` request,
  // and nowhere else.
  api.use(loadConsoleAuth);

  // Better Auth's own routes (sign-in, sign-out, get-session), which it
  // routes itself under its base path. Its disabled routes answer 404 there.
  api.on(["GET", "POST"], "/auth/*", (c) => c.var.consoleAuth.handler(c.req.raw));

  // Who am I (#81): the signed-in user, from a session the cookie cache may
  // vouch for.
  api.get("/me", requireSession, (c) => {
    const { userId, userName, isAdmin } = c.var.session;
    return c.json({ id: userId, userName, isAdmin });
  });

  // A sub-app's `notFound` is never called once it is mounted — Hono only
  // runs the top-level app's — so the unknown paths are caught by a route.
  api.all("*", (c) => c.json({ error: "not_found" }, 404));

  return api;
}
