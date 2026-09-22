import { Hono } from "hono";
import { scrobble, setRating, star, unstar } from "./endpoints/annotations";
import { getAlbum, getArtist, getArtists, getGenres, getSong } from "./endpoints/browsing";
import { getIndexes, getMusicDirectory, getMusicFolders } from "./endpoints/folders";
import {
  getAlbumList2,
  getRandomSongs,
  getSongsByGenre,
  getStarred2,
  getTopSongs,
} from "./endpoints/lists";
import { getLyricsBySongId } from "./endpoints/lyrics";
import { download, getCoverArt, stream } from "./endpoints/media";
import { notImplemented } from "./endpoints/not-implemented";
import {
  createBookmark,
  deleteBookmark,
  getBookmarks,
  getNowPlaying,
  getPlayQueue,
  savePlayQueue,
} from "./endpoints/playback";
import {
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  getPlaylists,
  updatePlaylist,
} from "./endpoints/playlists";
import { getScanStatus, startScan } from "./endpoints/scanning";
import { search2, search3 } from "./endpoints/search";
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

  // The API lives entirely under `/rest/`, but a client checks the bare server
  // URL is reachable before it authenticates: Amperfy's `checkServerReachablity`
  // does a plain GET of the root and treats any status >= 400 (except 401) as
  // "server unreachable", which a 404 here would trip, blocking login before
  // the first `ping`. Answer the root with 200 so that probe succeeds; real
  // servers (Navidrome) serve a page here too. Hono routes HEAD to this GET.
  app.get("/", (c) => c.text("Stratosonic — OpenSubsonic API. Endpoints are under /rest/.\n"));

  // Public: no authentication, as the OpenSubsonic spec requires.
  registerEndpoint(app, "getOpenSubsonicExtensions", getOpenSubsonicExtensions, { public: true });

  registerEndpoint(app, "ping", ping);
  registerEndpoint(app, "getLicense", getLicense);

  // Browsing (ID3): the artist -> album -> track walk, and the genre list.
  registerEndpoint(app, "getArtists", getArtists);
  registerEndpoint(app, "getArtist", getArtist);
  registerEndpoint(app, "getAlbum", getAlbum);
  registerEndpoint(app, "getSong", getSong);
  registerEndpoint(app, "getGenres", getGenres);

  // Navidrome mounts `getTopSongs` here, with the browsing endpoints, because
  // it answers one artist's page rather than a home screen; the handler lives
  // in the Lists module with the other song lists.
  registerEndpoint(app, "getTopSongs", getTopSongs);

  // Browsing (folders): the same library as one music folder of directories.
  registerEndpoint(app, "getMusicFolders", getMusicFolders);
  registerEndpoint(app, "getIndexes", getIndexes);
  registerEndpoint(app, "getMusicDirectory", getMusicDirectory);

  // Lists: the home screens, and the lists a client's first sync reads.
  registerEndpoint(app, "getAlbumList2", getAlbumList2);
  registerEndpoint(app, "getRandomSongs", getRandomSongs);
  registerEndpoint(app, "getSongsByGenre", getSongsByGenre);
  registerEndpoint(app, "getStarred2", getStarred2);
  registerEndpoint(app, "getNowPlaying", getNowPlaying);

  // Searching: the search box, over the library the client already has.
  // Navidrome mounts these between the lists and the playlists.
  registerEndpoint(app, "search2", search2);
  registerEndpoint(app, "search3", search3);

  // Playlists: what the cron imported from the `.m3u` files in the bucket,
  // and the three writes that put a file there themselves. In Navidrome's
  // order (server/subsonic/api.go), which puts the creates and updates
  // before the deletes.
  registerEndpoint(app, "getPlaylists", getPlaylists);
  registerEndpoint(app, "getPlaylist", getPlaylist);
  registerEndpoint(app, "createPlaylist", createPlaylist);
  registerEndpoint(app, "updatePlaylist", updatePlaylist);
  registerEndpoint(app, "deletePlaylist", deletePlaylist);

  // Annotations: what a client saves about an item. Each answers an empty ok
  // envelope and writes only the caller's rows.
  registerEndpoint(app, "star", star);
  registerEndpoint(app, "unstar", unstar);
  registerEndpoint(app, "setRating", setRating);
  registerEndpoint(app, "scrobble", scrobble);

  registerEndpoint(app, "getUser", getUser);
  registerEndpoint(app, "getUsers", getUsers, { adminOnly: true });

  // Bookmarks, which is where the spec — and Navidrome's router, after the
  // user endpoints — files the play queue as well: what a client saves to
  // resume a session on another device.
  registerEndpoint(app, "getBookmarks", getBookmarks);
  registerEndpoint(app, "createBookmark", createBookmark);
  registerEndpoint(app, "deleteBookmark", deleteBookmark);
  registerEndpoint(app, "getPlayQueue", getPlayQueue);
  registerEndpoint(app, "savePlayQueue", savePlayQueue);

  // Lyrics, which Navidrome mounts in its media group ahead of `stream`: read
  // from the sidecar beside the track when a client asks, so they answer with
  // an envelope and write nothing.
  registerEndpoint(app, "getLyricsBySongId", getLyricsBySongId);

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

  // Media library scanning, which is the last group of Navidrome's router and
  // the last of the Subsonic API's own list. Admin-only, as Navidrome mounts
  // it: a scan is server-wide, not one listener's business.
  registerEndpoint(app, "getScanStatus", getScanStatus, { adminOnly: true });
  registerEndpoint(app, "startScan", startScan, { adminOnly: true });

  registerUnknownEndpointHandler(app);

  return app;
}
