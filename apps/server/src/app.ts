import { Hono } from "hono";
import { getOpenSubsonicExtensions, ping } from "./endpoints/system";
import {
  registerEndpoint,
  registerErrorHandler,
  registerUnknownEndpointHandler,
  type SubsonicApp,
} from "./subsonic/router";

/** Builds the Subsonic API surface. Endpoints are registered here, in order. */
export function createApp(): SubsonicApp {
  const app: SubsonicApp = new Hono();

  registerErrorHandler(app);

  // Public: no authentication, as the OpenSubsonic spec requires.
  registerEndpoint(app, "getOpenSubsonicExtensions", getOpenSubsonicExtensions, { public: true });

  registerEndpoint(app, "ping", ping);

  registerUnknownEndpointHandler(app);

  return app;
}
