import { Hono } from "hono";
import { getLicense, getOpenSubsonicExtensions, ping } from "./endpoints/system";
import { getUser } from "./endpoints/users";
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
  registerEndpoint(app, "getLicense", getLicense);

  registerEndpoint(app, "getUser", getUser);

  registerUnknownEndpointHandler(app);

  return app;
}
