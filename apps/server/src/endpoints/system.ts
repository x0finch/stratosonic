import type { SubsonicHandler } from "../subsonic/router";

/**
 * The OpenSubsonic extensions this server implements.
 *
 * Only extensions that are actually supported belong here: clients take this
 * list as a promise. `formPost` (version 1) is the promise that every endpoint
 * accepts its parameters in a form-encoded POST body, which the route registry
 * does for all endpoints it mounts.
 */
const OPEN_SUBSONIC_EXTENSIONS = [{ name: "formPost", versions: [1] }];

/**
 * `getOpenSubsonicExtensions` — unauthenticated, as the OpenSubsonic spec
 * requires, so clients can probe the server before they have credentials. Auth
 * parameters may be present; they are simply ignored.
 */
export const getOpenSubsonicExtensions: SubsonicHandler = () => ({
  openSubsonicExtensions: OPEN_SUBSONIC_EXTENSIONS,
});
