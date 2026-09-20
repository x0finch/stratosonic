import { Hono } from "hono";
import { registerUnknownEndpointHandler, type SubsonicApp } from "./subsonic/router";

/** Builds the Subsonic API surface. Endpoints are registered here, in order. */
export function createApp(): SubsonicApp {
  const app: SubsonicApp = new Hono();

  registerUnknownEndpointHandler(app);

  return app;
}
