import { Hono } from "hono";
import { getOpenSubsonicExtensions } from "./endpoints/system";
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

  // Public: no authentication (see issue #2; auth arrives with the System
  // module's remaining endpoints).
  registerEndpoint(app, "getOpenSubsonicExtensions", getOpenSubsonicExtensions);

  registerUnknownEndpointHandler(app);

  return app;
}
