/**
 * Where an album's cover lives once the scan has pulled it out of a track.
 *
 * A cover is stored as its own object under `_covers/`, named after the album
 * it belongs to, with the content type the tag declared written into the
 * object's HTTP metadata. `getCoverArt` reads the album's stored key verbatim
 * and prefers that declared type (`media/images.ts`), so nothing else has to
 * agree with this module about either the name or the type.
 *
 * `_covers/` is also the one prefix the scan refuses to treat as music, so a
 * cover can never be listed as a track however it is named.
 */

import type { EmbeddedCover } from "../library/metadata";

/** The prefix every extracted cover is written under. */
export const COVER_PREFIX = "_covers/";

/**
 * The extension each image type is stored with. The map exists so that a JPEG
 * is `.jpg` rather than `.jpeg`, and so the four types `getCoverArt` can
 * recognise from their bytes alone are named the way it expects.
 */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * What to call the file holding an image of this type.
 *
 * An unlisted `image/...` type keeps its own subtype as the extension rather
 * than being dropped: the object's stored content type is what a client is
 * served, so an unusual format still reaches it correctly, and the extension
 * is only a name. Anything that is not an image at all has no name here - a
 * tag that declares `text/plain` is not artwork.
 */
export function coverExtension(mimeType: string): string | null {
  const type = mimeType.trim().toLowerCase();

  const known = IMAGE_EXTENSIONS[type];
  if (known) {
    return known;
  }

  if (!type.startsWith("image/")) {
    return null;
  }

  // `image/x-foo; charset=binary` names the format "foo": the parameters and
  // the `x-` of an experimental type say nothing about the bytes.
  const subtype = (type.slice("image/".length).split(";")[0] ?? "")
    .replace(/^x-/, "")
    .replace(/[^a-z0-9]/g, "");

  return subtype === "" ? null : subtype.slice(0, 8);
}

/** Where this album's cover goes, or null when the image has no usable type. */
export function coverKeyFor(albumId: string, cover: EmbeddedCover): string | null {
  const extension = coverExtension(cover.mimeType);

  return extension === null ? null : `${COVER_PREFIX}${albumId}.${extension}`;
}

/** Whether this key is one of the covers the scan writes, not a track. */
export function isCoverKey(r2Key: string): boolean {
  return r2Key.startsWith(COVER_PREFIX);
}
