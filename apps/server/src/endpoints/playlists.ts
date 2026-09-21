/**
 * The Playlists module: the list of playlists, one playlist with its songs,
 * and the two writes a client makes.
 *
 * The reads answer from the rows the cron's importer writes out of the `.m3u`
 * files in the bucket (`playlists/import.ts`). The writes go *through* the
 * bucket rather than around it: the `.m3u` is written first and the row
 * follows from it, so a playlist a listener made in a client is an ordinary
 * playlist the next import agrees with, entry for entry (ADR-0006,
 * `playlists/writes.ts`).
 *
 * Three rules the module keeps, beyond the ones the whole API keeps:
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
 * - **Seeing a playlist and writing it are different permissions.** A read is
 *   Navidrome's `userFilter`; a write is its `isWritable`, the owner or an
 *   admin, and someone else's playlist is refused with error 50 rather than
 *   hidden behind error 70 - the caller is being refused, not told the
 *   playlist is gone.
 *
 * All three writes take the same route: the whole `.m3u` is rendered and put,
 * and the row follows from it. `updatePlaylist` is therefore not an edit of a
 * stored list but a read of the current one, an edit in memory, and a write of
 * the result - which is also what makes it converge with the next import.
 */

import { parseIdOfType } from "@stratosonic/db";
import { type Database, database } from "../db";
import { omitWhenEmpty, playlistElement, songElement } from "../library/serializers";
import { DEFAULT_PUBLIC } from "../playlists/import";
import {
  type EntryTrack,
  findPlaylist,
  findTracksByIds,
  findWritablePlaylist,
  listPlaylistEntries,
  listPlaylistEntryTracks,
  listPlaylists,
  type PlaylistViewer,
  type WritablePlaylist,
} from "../playlists/repository";
import { erasePlaylist, newPlaylistKey, writePlaylist } from "../playlists/writes";
import { integerParameterValue, requiredParameter } from "../subsonic/params";
import { SubsonicError, SubsonicErrorCode, type SubsonicNode } from "../subsonic/response";
import type { AuthenticatedSubsonicRequest, SubsonicHandler } from "../subsonic/router";

/** Navidrome's message for a playlist it cannot produce. */
const NOT_FOUND = "playlist not found";

/** How many `songId`s one write may name, so its lookup stays affordable. */
const MAX_SONGS_PER_REQUEST = 1000;

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

  return playlistWithEntries(db, request, id);
};

/**
 * `createPlaylist` - a new playlist named by `name`, or the songs of an
 * existing one replaced when `playlistId` is given instead.
 *
 * The two cases are Navidrome's (server/subsonic/playlists.go): `playlistId`
 * wins when both are sent and `name` is ignored in that branch, because only
 * the songs were asked about; neither parameter is error 10 naming both. The
 * answer is the playlist itself, entries and all, exactly as `getPlaylist`
 * renders it - which is what the newer API versions promise and what lets a
 * client show what it just made without another round trip.
 */
export const createPlaylist: SubsonicHandler = async (request) => {
  const db = database(request.env);
  const requestedId = request.params.get("playlistId") ?? "";
  const name = request.params.get("name") ?? "";

  if (requestedId === "" && name === "") {
    // Navidrome's `req.NewMissingParamError("name or playlistId")`, wording
    // and all, so a client reports what both servers report.
    throw new SubsonicError(
      SubsonicErrorCode.MissingParameter,
      "missing parameter: 'name or playlistId'",
    );
  }

  const tracks = await requestedTracks(db, request.params.getAll("songId"));
  const held = requestedId === "" ? null : await writable(db, request, requestedId);

  const id = await writePlaylist(request.env, db, {
    r2Key: held?.r2Key ?? newPlaylistKey(),
    name: held?.name ?? name,
    comment: held?.comment ?? "",
    ownerId: held?.ownerId ?? request.user.id,
    public: held?.public ?? DEFAULT_PUBLIC,
    createdAt: held?.createdAt ?? null,
    tracks,
  });

  return playlistWithEntries(db, request, id);
};

/**
 * `updatePlaylist` - the edits a client makes to a playlist it already has:
 * its `name`, `comment` and `public` flag, songs appended by `songIdToAdd`,
 * and songs dropped by `songIndexToRemove`.
 *
 * **The removals are read against the playlist as it was before this call,
 * and the additions are appended after them**, which is Navidrome's order
 * (`playlists.Update` removes by index and then adds, core/playlists.go). A
 * client that sends both in one request is describing one edit of the list it
 * is looking at, so an index means the position the listener saw, never a
 * position that only exists once the additions have landed.
 *
 * An index naming no position is ignored rather than refused, as Navidrome
 * ignores it: a client and a server can disagree about a playlist's length
 * for a moment, and the listener's other removals should still happen.
 *
 * Every parameter but `playlistId` is optional, and each is left alone when
 * it is absent - not reset. `name` absent keeps the name; `name=` empty is
 * not a rename either, because a nameless playlist is one the `.m3u` cannot
 * spell. The answer is an empty ok, as Navidrome answers.
 *
 * The file is re-rendered and put before the row is written, exactly as a
 * create does it, so `changed` moves to the new object's upload time and
 * `created` stays. The key does not change, and the id is the hash of the
 * key, so a rename leaves both alone - which is the point of not naming the
 * file after the playlist (ADR-0006).
 */
export const updatePlaylist: SubsonicHandler = async (request) => {
  const { params } = request;
  const db = database(request.env);
  const held = await writable(db, request, requiredParameter(params, "playlistId"));

  const [current, added] = await Promise.all([
    listPlaylistEntryTracks(db, held.id),
    requestedTracks(db, params.getAll("songIdToAdd")),
  ]);

  const removed = requestedRemovals(params);
  const kept = current.filter((_, index) => !removed.has(index));

  await writePlaylist(request.env, db, {
    r2Key: held.r2Key,
    name: params.get("name") || held.name,
    comment: params.get("comment") ?? held.comment,
    ownerId: held.ownerId,
    public: booleanParameter(params, "public") ?? held.public,
    createdAt: held.createdAt,
    tracks: [...kept, ...added],
    writesDetails: true,
  });

  return {};
};

/**
 * The positions `songIndexToRemove` names, as a set so the order they arrive
 * in and any repeats do not matter.
 *
 * A value that is not a whole number is error 0, as it is for every other
 * integer parameter; Navidrome's `p.Ints` quietly drops it instead, which
 * would turn a client's typo into a removal that silently did not happen.
 */
function requestedRemovals(params: URLSearchParams): ReadonlySet<number> {
  return new Set(
    params
      .getAll("songIndexToRemove")
      .map((value) => integerParameterValue("songIndexToRemove", value)),
  );
}

/**
 * A flag the client either sent or did not: `null` means "leave it alone",
 * which is how `updatePlaylist` tells an unchanged `public` from one set to
 * false.
 *
 * "true" and "1" are true and everything else is false, as Navidrome's
 * `p.Bool` reads it.
 */
function booleanParameter(params: URLSearchParams, name: string): boolean | null {
  const value = params.get(name);

  return value === null ? null : value.toLowerCase() === "true" || value === "1";
}

/**
 * `deletePlaylist` - removes the `.m3u` and the row it stands for, and
 * answers with an empty ok, as Navidrome does. Only the owner or an admin
 * may; anyone else is refused rather than quietly ignored.
 */
export const deletePlaylist: SubsonicHandler = async (request) => {
  const db = database(request.env);
  const held = await writable(db, request, requiredParameter(request.params, "id"));

  await erasePlaylist(request.env, db, held.id, held.r2Key);

  return {};
};

/** One playlist as `getPlaylist` answers with it, or error 70. */
async function playlistWithEntries(
  db: Database,
  request: AuthenticatedSubsonicRequest,
  id: string,
): Promise<SubsonicNode> {
  const playlist = await findPlaylist(db, viewer(request), id);
  if (playlist === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound, NOT_FOUND);
  }

  const entries = await listPlaylistEntries(db, playlist.id, request.user.id);

  return {
    playlist: { ...playlistElement(playlist), entry: omitWhenEmpty(entries.map(songElement)) },
  };
}

/**
 * The playlist this client-facing id names, if the caller may write it:
 * Navidrome's `isWritable`, which is the owner or an admin. An id that names
 * nothing - or is not one of ours at all - is error 70, as everywhere else.
 */
async function writable(
  db: Database,
  request: AuthenticatedSubsonicRequest,
  requestedId: string,
): Promise<WritablePlaylist> {
  const id = parseIdOfType("playlist", requestedId);
  const held = id === null ? null : await findWritablePlaylist(db, id);
  if (held === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound, NOT_FOUND);
  }

  if (held.ownerId !== request.user.id && !request.user.isAdmin) {
    throw new SubsonicError(SubsonicErrorCode.NotAuthorized);
  }

  return held;
}

/**
 * The tracks these `songId`s name, in the order the client sent them and with
 * its duplicates kept - a playlist may play a track twice.
 *
 * An id that names no track fails the whole call with error 70: a playlist
 * silently missing songs the listener picked is worse than a refusal the
 * client can report. The lookup is one statement per ninety distinct ids, so
 * a playlist of hundreds of songs costs a handful of them rather than
 * throwing on D1's parameter limit.
 *
 * More than `MAX_SONGS_PER_REQUEST` of them is error 0, as it is on every
 * other endpoint here that takes a repeatable id (`star`, `scrobble`,
 * `savePlayQueue`). Those statements are subrequests, and a free-plan
 * invocation has fifty; at the cap the lookup is twelve of them, leaving room
 * for the R2 put and the batch that follow. Navidrome has no cap because it
 * has no such budget.
 */
async function requestedTracks(
  db: Database,
  songIds: readonly string[],
): Promise<readonly EntryTrack[]> {
  if (songIds.length > MAX_SONGS_PER_REQUEST) {
    throw new SubsonicError(
      SubsonicErrorCode.Generic,
      `too many ids: ${songIds.length}, at most ${MAX_SONGS_PER_REQUEST} per request`,
    );
  }

  const ids = songIds.map((value) => parseIdOfType("track", value));
  const found = await findTracksByIds(db, [...new Set(ids.filter((id) => id !== null))]);

  return ids.map((id) => {
    const entry = id === null ? undefined : found.get(id);
    if (entry === undefined) {
      throw new SubsonicError(SubsonicErrorCode.NotFound, "Song not found");
    }

    return entry;
  });
}

function viewer(request: AuthenticatedSubsonicRequest): PlaylistViewer {
  return { id: request.user.id, isAdmin: request.user.isAdmin };
}
