import { parseIdOfType, type Track } from "@stratosonic/db";
import { database } from "../db";
import { audioContentType } from "../library/audio-formats";
import { attachmentDisposition, baseName } from "../media/content-disposition";
import { headStoredObject, serveStoredObject } from "../media/objects";
import { findTrackById } from "../media/repository";
import { requiredParameter } from "../subsonic/params";
import { SubsonicError, SubsonicErrorCode } from "../subsonic/response";
import type { AuthenticatedSubsonicRequest, SubsonicHandler } from "../subsonic/router";

/**
 * The Media module: `stream`, `download` and `getCoverArt`.
 *
 * All three answer with bytes rather than with an envelope, and all three
 * answer a failure the way every other endpoint does — inside the envelope,
 * with an error code — so a client never has to guess whether the body it got
 * is a song or an apology.
 *
 * Stratosonic does not transcode (ADR-0001): `format`, `maxBitRate`,
 * `timeOffset` and `estimateContentLength` are read by clients' request
 * builders and ignored here, and the original object is served as it is. A
 * client that asks for mp3 and is given the FLAC it asked about plays it;
 * transcoding it here would turn R2's free egress into billed bandwidth for
 * no gain on the players this server exists for.
 */

/** What an object is sent as when its suffix is not one we know. */
const UNKNOWN_CONTENT_TYPE = "application/octet-stream";

/**
 * Serves a track's original bytes, honouring a `Range` so a client can seek.
 */
export const stream: SubsonicHandler = async (request) => {
  const track = await requireTrack(request);
  const head = await headStoredObject(request.env, track.r2Key);

  return serveStoredObject(request.env, track.r2Key, head, request.raw, {
    contentType: audioContentType(track.suffix) ?? UNKNOWN_CONTENT_TYPE,
  });
};

/**
 * The same bytes as `stream`, with the file name to save them under.
 *
 * Navidrome answers `download` for albums, artists and playlists too, by
 * zipping them; that needs a compressor and the whole library's egress, so
 * Stratosonic downloads one track at a time and answers anything else with
 * "not found".
 */
export const download: SubsonicHandler = async (request) => {
  const track = await requireTrack(request);
  const head = await headStoredObject(request.env, track.r2Key);

  return serveStoredObject(request.env, track.r2Key, head, request.raw, {
    contentType: audioContentType(track.suffix) ?? UNKNOWN_CONTENT_TYPE,
    contentDisposition: attachmentDisposition(baseName(track.r2Key)),
  });
};

/**
 * The track a request names, or error 70.
 *
 * An id that is not a track's — an album's, or one this server could never
 * have minted — is "not found" rather than a bad request, as it is in
 * Navidrome, where every id that resolves to nothing ends at `ErrNotFound`.
 */
async function requireTrack(request: AuthenticatedSubsonicRequest): Promise<Track> {
  const id = parseIdOfType("track", requiredParameter(request.params, "id"));

  const found = id === null ? null : await findTrackById(database(request.env), id);
  if (found === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound);
  }

  return found;
}
