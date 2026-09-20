import type { AuthenticatedUser } from "../auth/authenticate";
import { MUSIC_FOLDER_ID } from "../library/music-folder";
import { requiredParameter } from "../subsonic/params";
import { SubsonicError, SubsonicErrorCode, type SubsonicNode } from "../subsonic/response";
import type { SubsonicHandler } from "../subsonic/router";
import { userNamesMatch } from "../users/repository";

/**
 * The Users module, read-only: a caller can look at their own account and an
 * admin can list the users, which here is the caller as well. Following
 * Navidrome (server/subsonic/users.go), no endpoint ever discloses another
 * account.
 */

/**
 * The account as `responses.User` declares it, attribute for attribute and in
 * the same order (server/subsonic/responses/responses.go).
 *
 * The roles Navidrome derives from its configuration are pinned to what this
 * server actually does: streaming and downloads are what it is for; scrobbling
 * is accepted; cover art follows Navidrome's `EnableArtworkUpload || IsAdmin`
 * with artwork upload off; sharing, the jukebox, podcasts, video conversion,
 * uploads, comments, playlists and settings are not implemented, so claiming
 * them would only make a client offer the user something that then fails.
 * `maxBitRate` is omitted rather than sent as 0, as Navidrome's `omitempty`
 * does, because nothing is transcoded (ADR-0001).
 */
function buildUserResponse(user: AuthenticatedUser): SubsonicNode {
  return {
    username: user.userName,
    email: user.email || undefined,
    scrobblingEnabled: true,
    adminRole: user.isAdmin,
    settingsRole: false,
    downloadRole: true,
    uploadRole: false,
    playlistRole: false,
    coverArtRole: user.isAdmin,
    commentRole: false,
    podcastRole: false,
    streamRole: true,
    jukeboxRole: false,
    shareRole: false,
    videoConversionRole: false,
    // XML renders this as repeated `<folder>` children and JSON as an array,
    // which is what `xml:"folder,omitempty"` on a []int32 produces in Go.
    folder: [MUSIC_FOLDER_ID],
  };
}

/**
 * `getUser` — the caller's own account, and only that. Navidrome compares the
 * requested name with `strings.EqualFold` and answers error 50 for anyone
 * else's, so a client cannot enumerate accounts through this endpoint.
 */
export const getUser: SubsonicHandler = (request) => {
  const username = requiredParameter(request.params, "username");

  if (!userNamesMatch(username, request.user.userName)) {
    throw new SubsonicError(SubsonicErrorCode.NotAuthorized);
  }

  return { user: buildUserResponse(request.user) };
};

/**
 * `getUsers` — the list of accounts an admin may see, which is the caller's
 * own. Navidrome answers the same way: `GetUsers` builds a one-element list
 * from the logged-in user, and the endpoint is mounted `adminOnly`, so a
 * non-admin gets error 50 before the handler runs.
 */
export const getUsers: SubsonicHandler = (request) => ({
  users: { user: [buildUserResponse(request.user)] },
});
