import { type EntityId, parseIdOfType, parsePrefixedId } from "@stratosonic/db";
import { verifyPublicImageToken } from "../auth/public-token";
import { database } from "../db";
import type { Env } from "../env";
import { NO_USER } from "../library/annotations";
import { audioContentType } from "../library/audio-formats";
import { findTrackToServe } from "../library/repository";
import { ALL_LIBRARIES, type LibraryScope, scopeOf } from "../library/scope";
import type { SongView } from "../library/serializers";
import { attachmentDisposition, baseName } from "../media/content-disposition";
import { coverContentType, declaredCoverContentType } from "../media/images";
import { headStoredObject, serveStoredObject } from "../media/objects";
import { findCoverKey } from "../media/repository";
import { boundStorage } from "../storage/binding";
import type { LibraryStorage } from "../storage/storage";
import { joinsLibraryRow, storageOfTrack } from "../storage/track-storage";
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
  const { track, storage } = await requireTrack(request);
  const head = await headStoredObject(storage, track.r2Key);

  return serveStoredObject(storage, track.r2Key, head, request.raw, {
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
  const { track, storage } = await requireTrack(request);
  const head = await headStoredObject(storage, track.r2Key);

  return serveStoredObject(storage, track.r2Key, head, request.raw, {
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

  const served =
    entity === null
      ? null
      : await serveCover(request.env, entity, request.raw, scopeOf(request.user));
  if (served === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound, ARTWORK_NOT_FOUND);
  }

  return served;
};

/**
 * `GET /share/img/<token>` — the public image URL Navidrome's
 * `publicurl.ImageURL` builds and its `handleImages` serves
 * (server/public/handle_images.go): no Subsonic credentials, because the
 * token is the authorization, and it authorizes this one cover only.
 *
 * Answers in plain HTTP, as Navidrome does, not in an envelope: a token that
 * does not verify is 400 `invalid request` — before any D1 statement, so a
 * forged URL costs the database nothing — and a valid one whose entity has no
 * cover (any more) is 404 `Artwork not found`. `size` is ignored, as
 * `getCoverArt` ignores it.
 */
export async function servePublicImage(env: Env, token: string, raw: Request): Promise<Response> {
  const id = env.PASSWORD_ENCRYPTION_KEY
    ? await verifyPublicImageToken(env.PASSWORD_ENCRYPTION_KEY, token)
    : null;
  const entity = id === null ? null : parsePrefixedId(id);
  if (entity === null) {
    return new Response("invalid request\n", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return (
    (await serveCover(env, entity, raw, ALL_LIBRARIES)) ??
    new Response(`${ARTWORK_NOT_FOUND}\n`, {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  );
}

/**
 * The cover an entity resolves to, as a response, or null when it has none —
 * shared by `getCoverArt` and the public image URL so both serve the same
 * bytes the same way. `getCoverArt` looks in the caller's libraries, and the
 * public image URL, which has no caller, in every one.
 */
async function serveCover(
  env: Env,
  entity: EntityId,
  raw: Request,
  scope: LibraryScope,
): Promise<Response | null> {
  const key = await findCoverKey(database(env), entity, scope);
  if (key === null) {
    return null;
  }

  // An album can name a cover the bucket no longer holds, which is the same
  // "no artwork" to a client as an album that never had one. Every library's
  // covers are in the bound bucket.
  const covers = boundStorage(env);
  const head = await covers.head(key);
  if (head === null) {
    return null;
  }

  // A HEAD is answered from the head() alone, as it is for a track: reading
  // the image's signature would spend a second R2 operation on a response
  // that carries no image. Such a request is told what the object says it is.
  const contentType =
    raw.method === "HEAD"
      ? declaredCoverContentType(head)
      : await coverContentType(covers, key, head);

  return serveStoredObject(covers, key, head, raw, { contentType });
}

/**
 * The track a request names, or error 70.
 *
 * An id that is not a track's — an album's, or one this server could never
 * have minted — is "not found" rather than a bad request, as it is in
 * Navidrome, where every id that resolves to nothing ends at `ErrNotFound`.
 *
 * The track is read as `NO_USER`: the answer is the bytes of a file, and no
 * element is rendered from it, so there is no annotation to decorate it with.
 * It is read in the caller's libraries, so a track out of them is not found
 * (#84), and its bytes come from its own library's storage, whose row the
 * lookup joins unless the caller sees library 1 alone
 * (storage/track-storage.ts). That is one statement either way, as before.
 */
async function requireTrack(
  request: AuthenticatedSubsonicRequest,
): Promise<{ readonly track: SongView; readonly storage: LibraryStorage }> {
  const { user } = request;
  const id = parseIdOfType("track", requiredParameter(request.params, "id"));

  const found =
    id === null
      ? null
      : await findTrackToServe(
          database(request.env),
          id,
          NO_USER,
          scopeOf(user),
          joinsLibraryRow(user.libraryIds),
        );
  if (found === null) {
    throw new SubsonicError(SubsonicErrorCode.NotFound);
  }

  return { track: found.song, storage: storageOfTrack(request.env, found.song, found.library) };
}
