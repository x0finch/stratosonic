import { Hono } from "hono";
import { download, getCoverArt, stream } from "./endpoints/media";
import { notImplemented } from "./endpoints/not-implemented";
import { getLicense, getOpenSubsonicExtensions, ping } from "./endpoints/system";
import { getUser, getUsers } from "./endpoints/users";
import {
  registerEndpoint,
  registerErrorHandler,
  registerUnknownEndpointHandler,
  type SubsonicApp,
} from "./subsonic/router";

/**
 * The account-management endpoints, which Stratosonic does not implement: the
 * one admin user comes from the environment (ADR-0004), and Navidrome answers
 * these with 501 as well.
 */
const USER_WRITE_ENDPOINTS = ["createUser", "updateUser", "deleteUser", "changePassword"];

/** Builds the Subsonic API surface. Endpoints are registered here, in order. */
export function createApp(): SubsonicApp {
  const app: SubsonicApp = new Hono();

  registerErrorHandler(app);

  // Public: no authentication, as the OpenSubsonic spec requires.
  registerEndpoint(app, "getOpenSubsonicExtensions", getOpenSubsonicExtensions, { public: true });

  registerEndpoint(app, "ping", ping);
  registerEndpoint(app, "getLicense", getLicense);

  registerEndpoint(app, "getUser", getUser);
  registerEndpoint(app, "getUsers", getUsers, { adminOnly: true });

  // Media: these answer with bytes rather than with an envelope, and with an
  // error envelope when there are no bytes to send.
  registerEndpoint(app, "stream", stream);
  registerEndpoint(app, "download", download);
  registerEndpoint(app, "getCoverArt", getCoverArt);

  // Managing accounts is not implemented. These stay authenticated, as they are
  // in Navidrome, where `h501` registers them inside the group that checks the
  // required parameters and the credentials first.
  for (const name of USER_WRITE_ENDPOINTS) {
    registerEndpoint(app, name, notImplemented);
  }

  registerUnknownEndpointHandler(app);

  return app;
}
