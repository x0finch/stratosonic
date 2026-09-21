/**
 * What a stored cover is sent as.
 *
 * The scanner writes each cover with the content type its tag declared, so
 * that is the first answer. An object written without one — by hand with
 * rclone, or by a scan older than that rule — would otherwise be served as a
 * bare byte stream, and a client shows a broken image where a picture belongs
 * (#9: a cover must never be mistaken for something that is not an image). So
 * its first bytes are read and the format recognised from them, which is what
 * the tag would have said anyway.
 */

import type { Env } from "../env";

/** Enough bytes for every signature below, RIFF's trailing marker included. */
const SIGNATURE_LENGTH = 12;

/** The formats an embedded cover is, in practice, always one of. */
const SIGNATURES: readonly { readonly type: string; readonly bytes: readonly number[] }[] = [
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
];

/** What an unrecognised cover is sent as: bytes, honestly labelled. */
const UNKNOWN_IMAGE_TYPE = "application/octet-stream";

/**
 * The content type of a cover object: what it was stored with, or what its
 * first bytes say it is.
 */
export async function coverContentType(env: Env, key: string, head: R2Object): Promise<string> {
  const stored = head.httpMetadata?.contentType;
  if (stored?.startsWith("image/")) {
    return stored;
  }

  const probe = await env.MUSIC.get(key, { range: { offset: 0, length: SIGNATURE_LENGTH } });
  if (probe === null) {
    return UNKNOWN_IMAGE_TYPE;
  }

  return sniffImageType(new Uint8Array(await probe.arrayBuffer()));
}

/** The format these leading bytes belong to. */
export function sniffImageType(bytes: Uint8Array): string {
  for (const { type, bytes: signature } of SIGNATURES) {
    if (signature.every((byte, index) => bytes[index] === byte)) {
      return type;
    }
  }

  // "RIFF....WEBP": between the two markers sits the file's own length.
  if (matchesAscii(bytes, 0, "RIFF") && matchesAscii(bytes, 8, "WEBP")) {
    return "image/webp";
  }

  return UNKNOWN_IMAGE_TYPE;
}

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  return [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}
