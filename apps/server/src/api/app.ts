import { Hono } from "hono";
import { CONSOLE_AUTH_ROUTES } from "../console-auth/auth";
import { type ConsoleEnv, loadConsoleAuth, requireSession } from "../console-auth/middleware";
import { permissionsOf } from "../console-auth/permissions";
import { registerAccountRoutes } from "./account";
import { registerOverviewRoutes } from "./overview";
import { registerSetupRoutes } from "./setup";
import { registerSubsonicUserRoutes } from "./subsonic-users";

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

  // The Better Auth routes the console uses, and no other: any other path
  // under `/api/auth` is the catch-all's JSON 404, whatever a Better Auth
  // upgrade adds. Better Auth refuses the rest itself as well
  // (console-auth/auth.ts).
  for (const { method, path } of CONSOLE_AUTH_ROUTES) {
    api.on(method, `/auth${path}`, (c) => c.var.consoleAuth.handler(c.req.raw));
  }

  // Who am I (#81, #99): the signed-in console user, from a session the
  // cookie cache may vouch for, with their role and what it grants, so the
  // console can leave out what they may not do. The routes check for
  // themselves.
  api.get("/me", requireSession, (c) => {
    const { userId, username, role } = c.var.session;
    return c.json({ id: userId, username, role, permissions: permissionsOf(role) });
  });

  // Every route below that writes goes behind `requireSameOrigin`
  // (api/same-origin.ts): Better Auth's own origin check covers only its
  // routes above.
  registerSetupRoutes(api);
  registerAccountRoutes(api);
  registerSubsonicUserRoutes(api);
  registerOverviewRoutes(api);

  // A sub-app's `notFound` is never called once it is mounted — Hono only
  // runs the top-level app's — so the unknown paths are caught by a route.
  api.all("*", (c) => c.json({ error: "not_found" }, 404));

  return api;
}
