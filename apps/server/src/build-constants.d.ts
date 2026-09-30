/**
 * Identifiers the bundler replaces at build time (`wrangler deploy --define`).
 * A build that does not define one leaves it undeclared at run time, so read
 * each one only through `typeof`, which does not throw for an undeclared name.
 */

/** The release being deployed, as `X.Y.Z` (src/subsonic/response.ts). */
declare const __SERVER_VERSION__: string | undefined;
