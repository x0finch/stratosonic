import { Hono } from "hono";
import type { Env } from "../env";

/**
 * The admin console's JSON API, mounted at `/api` (#87).
 *
 * It is not part of the Subsonic protocol and never answers with the Subsonic
 * envelope: a client of `/api` is the console, which reads plain JSON and an
 * HTTP status. That holds for the paths it does not know and for a handler
 * that throws, which would otherwise fall through to the Subsonic app's own
 * not-found and error handlers.
 */
export type ApiApp = Hono<{ Bindings: Env }>;

/** Builds the console API. Routes are registered here, ahead of the catch-all. */
export function createApiApp(): ApiApp {
  const api: ApiApp = new Hono();

  api.onError((error, c) => {
    console.error("admin api: a handler failed", error);
    return c.json({ error: "internal" }, 500);
  });

  // A sub-app's `notFound` is never called once it is mounted — Hono only
  // runs the top-level app's — so the unknown paths are caught by a route.
  api.all("*", (c) => c.json({ error: "not_found" }, 404));

  return api;
}
