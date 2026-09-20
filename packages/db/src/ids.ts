/**
 * Entity ids, following Navidrome's `model/id` package: 16 bytes rendered as a
 * zero-padded 22-character base62 string.
 *
 * Users get a *random* id (`newRandomId`, Navidrome's `id.NewRandom`). The
 * content-hash variant Navidrome uses for library entities — `base62(md5(...))`,
 * ADR-0002 — belongs to the library tables and arrives with them in Phase 1.
 */

/** Digits in the order Go's `big.Int.Text(62)` emits them. */
const BASE62_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** 16 bytes of base62 never need more than this many digits. */
export const ID_LENGTH = 22;

/** A fresh random id, as Navidrome mints for users. */
export function newRandomId(): string {
  return encodeId(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Renders 16 bytes as the canonical id. The value is read as one big-endian
 * unsigned integer and printed in base62, left-padded with the base62 zero
 * digit so every id is the same width.
 */
export function encodeId(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new Error(`an id is made of 16 bytes, got ${bytes.length}`);
  }

  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  let digits = "";
  while (value > 0n) {
    digits = BASE62_DIGITS[Number(value % 62n)] + digits;
    value /= 62n;
  }

  return digits.padStart(ID_LENGTH, BASE62_DIGITS[0]);
}
