/**
 * The Playlists module, read side: the list of playlists and one playlist
 * with its songs.
 *
 * Both answer from the rows the cron's importer writes out of the `.m3u`
 * files in the bucket (`playlists/import.ts`); nothing here reads R2.
 *
 * Two rules the module keeps, beyond the ones the whole API keeps:
 *
 * - **`getPlaylists` is authoritative and never fails.** A client treats the
 *   list as the whole truth and deletes the playlists it does not find in it
 *   (#9), so the list is complete - no paging, no filter - and an empty
 *   library answers with an empty `<playlists/>` rather than an error. That
 *   also holds while an import is in flight: a pass writes each playlist
 *   whole, in one transaction, so a client reading mid-pass sees fewer
 *   playlists, never a broken one.
 * - **An id that names nothing is "not found", not an error about ids.** A
 *   missing `id` is error 10, because the request cannot be understood at
 *   all; an id that is malformed, names nothing, or names another kind of
 *   thing is error 70, which is also the answer for a playlist whose `.m3u`
 *   has been deleted - usually what it is.
 *
 * The write endpoints (`createPlaylist`, `updatePlaylist`, `deletePlaylist`)
 * are Phase 2 (#9) and are not mounted at all, so they answer with the error
 * 70 every unimplemented `/rest/` name answers with (ADR-0005).
 */

import { parseIdOfType } from "@stratosonic/db";
import { database } from "../db";
import { omitWhenEmpty, playlistElement, songElement } from "../library/serializers";
import {
  findPlaylist,
  listPlaylistEntries,
  listPlaylists,
  type PlaylistViewer,
} from "../playlists/repository";
import { requiredParameter } from "../subsonic/params";
import { SubsonicError, SubsonicErrorCode } from "../subsonic/response";
import type { AuthenticatedSubsonicRequest, SubsonicHandler } from "../subsonic/router";

/** Navidrome's message for a playlist it cannot produce. */
const NOT_FOUND = "playlist not found";

/**
 * `getPlaylists` - every playlist the caller may see, by name.
 *
 * The spec's `username` parameter is read by nobody here, as Navidrome reads
 * it nowhere either: its `GetPlaylists` asks the repository for everything
 * the logged-in user may see and ignores the parameter
 * (server/subsonic/playlists.go). Answering error 50 to a client that sends
 * its own username - which some do - would break the very sync this list
 * exists for, and this server has one account anyway.
 *
 * Who may see what is Navidrome's `playlistRepository.userFilter`: an admin
 * sees every playlist, and anyone else sees the public ones and their own.
 */
export const getPlaylists: SubsonicHandler = async (request) => {
  const playlists = await listPlaylists(database(request.env), viewer(request));

  return { playlists: { playlist: omitWhenEmpty(playlists.map(playlistElement)) } };
};

/** `getPlaylist` - one playlist and its `<entry>` songs, in playlist order. */
export const getPlaylist: SubsonicHandler = async (request) => {
  const db = database(request.env);
  const id = parseIdOfType("playlist", requiredParameter(request.params, "id"));
  if (id === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound, NOT_FOUND);
  }

  const playlist = await findPlaylist(db, viewer(request), id);
  if (playlist === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound, NOT_FOUND);
  }

  const entries = await listPlaylistEntries(db, playlist.id, request.user.id);

  return {
    playlist: { ...playlistElement(playlist), entry: omitWhenEmpty(entries.map(songElement)) },
  };
};

function viewer(request: AuthenticatedSubsonicRequest): PlaylistViewer {
  return { id: request.user.id, isAdmin: request.user.isAdmin };
}
