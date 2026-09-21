import { parseIdOfType, parsePrefixedId } from "@stratosonic/db";
import { database } from "../db";
import { audioContentType } from "../library/audio-formats";
import { findTrack } from "../library/repository";
import type { SongView } from "../library/serializers";
import { attachmentDisposition, baseName } from "../media/content-disposition";
import { coverContentType, declaredCoverContentType } from "../media/images";
import { headStoredObject, serveStoredObject } from "../media/objects";
import { findCoverKey } from "../media/repository";
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

/** Navidrome's message for a cover it cannot produce. */
const ARTWORK_NOT_FOUND = "Artwork not found";

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
 * Serves the cover an `al-`, `ar-` or `tr-` id resolves to.
 *
 * `size` is accepted and ignored: the stored cover is served unchanged.
 * Resizing needs either Cloudflare Images, which wants a zone, or a decoder
 * running on a Worker's CPU budget, and neither is available on the free tier
 * (ADR-0004) — so thumbnails are backlog, and a client that asked for 300
 * pixels gets a picture that is merely larger than it wanted.
 */
export const getCoverArt: SubsonicHandler = async (request) => {
  const id = requiredParameter(request.params, "id");
  const entity = parsePrefixedId(id);

  const key = entity === null ? null : await findCoverKey(database(request.env), entity);
  if (key === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound, ARTWORK_NOT_FOUND);
  }

  // An album can name a cover the bucket no longer holds, which is the same
  // "no artwork" to a client as an album that never had one.
  const head = await headStoredObject(request.env, key, ARTWORK_NOT_FOUND);

  // A HEAD is answered from the head() alone, as it is for a track: reading
  // the image's signature would spend a second R2 operation on a response
  // that carries no image. Such a request is told what the object says it is.
  const contentType =
    request.raw.method === "HEAD"
      ? declaredCoverContentType(head)
      : await coverContentType(request.env, key, head);

  return serveStoredObject(request.env, key, head, request.raw, { contentType });
};

/**
 * The track a request names, or error 70.
 *
 * An id that is not a track's — an album's, or one this server could never
 * have minted — is "not found" rather than a bad request, as it is in
 * Navidrome, where every id that resolves to nothing ends at `ErrNotFound`.
 */
async function requireTrack(request: AuthenticatedSubsonicRequest): Promise<SongView> {
  const id = parseIdOfType("track", requiredParameter(request.params, "id"));

  const found = id === null ? null : await findTrack(database(request.env), id);
  if (found === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound);
  }

  return found;
}
