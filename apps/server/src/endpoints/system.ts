import type { PublicSubsonicHandler, SubsonicHandler } from "../subsonic/router";

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
export const getOpenSubsonicExtensions: PublicSubsonicHandler = () => ({
  openSubsonicExtensions: OPEN_SUBSONIC_EXTENSIONS,
});

/**
 * `ping` — an empty successful envelope. Clients use it to check the server and
 * their credentials, so it is authenticated: that is the whole point of the
 * call, and it is what Navidrome does (server/subsonic/system.go).
 */
export const ping: SubsonicHandler = () => ({});

/**
 * `getLicense` — Stratosonic is not licensed per install, so the licence is
 * always valid. Navidrome answers with the same single `valid` attribute
 * (server/subsonic/system.go and its `responses.License`), and nothing else:
 * the optional email and expiry attributes are left out rather than invented.
 */
export const getLicense: SubsonicHandler = () => ({ license: { valid: true } });
