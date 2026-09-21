/**
 * MD5 (RFC 1321) over bytes.
 *
 * Entity ids are `base62(md5(...))` (ADR-0002), so MD5 is not a security
 * choice here — it is the digest Navidrome's id scheme is defined in terms of,
 * and the ids have to come out the same wherever they are computed.
 *
 * It is implemented here rather than taken from a runtime because no runtime
 * offers it everywhere this code runs: workerd has `crypto.subtle.digest("MD5")`
 * but Node's WebCrypto does not, and Node's `node:crypto` is not available in
 * the Worker's dependency-free path. A hand-written digest is also synchronous,
 * which keeps id derivation an ordinary expression instead of spreading
 * `await` through every caller. Correctness is pinned by tests against the
 * RFC's own vectors and against an independent implementation.
 */

/** Per-round left-rotation amounts. */
// biome-ignore format: the table is read four rounds to a line.
const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/**
 * The RFC's sine table, `floor(abs(sin(i + 1)) * 2^32)`. It is written out
 * rather than computed so the digest cannot drift with a runtime's `Math.sin`.
 */
// biome-ignore format: the table is read four constants to a line.
const SINE = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);

/** The 16-byte MD5 digest of `message`. */
export function md5(message: Uint8Array): Uint8Array {
  const block = padded(message);
  const words = new DataView(block.buffer, block.byteOffset, block.byteLength);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < block.length; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let mixed: number;
      let word: number;

      if (i < 16) {
        mixed = (b & c) | (~b & d);
        word = i;
      } else if (i < 32) {
        mixed = (d & b) | (~d & c);
        word = (5 * i + 1) % 16;
      } else if (i < 48) {
        mixed = b ^ c ^ d;
        word = (3 * i + 5) % 16;
      } else {
        mixed = c ^ (b | ~d);
        word = (7 * i) % 16;
      }

      const sum =
        (mixed + a + (SINE[i] as number) + words.getUint32(offset + word * 4, true)) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotateLeft(sum, SHIFTS[i] as number)) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const digest = new Uint8Array(16);
  const out = new DataView(digest.buffer);
  out.setUint32(0, a0, true);
  out.setUint32(4, b0, true);
  out.setUint32(8, c0, true);
  out.setUint32(12, d0, true);

  return digest;
}

/**
 * The message followed by a `0x80` byte, zeroes, and its length in bits as a
 * little-endian 64-bit integer, rounded up to whole 64-byte blocks.
 */
function padded(message: Uint8Array): Uint8Array {
  const length = (((message.length + 8) >> 6) + 1) << 6;
  const block = new Uint8Array(length);
  block.set(message);
  block[message.length] = 0x80;

  const bits = message.length * 8;
  const view = new DataView(block.buffer);
  view.setUint32(length - 8, bits >>> 0, true);
  view.setUint32(length - 4, Math.floor(bits / 2 ** 32), true);

  return block;
}

function rotateLeft(value: number, by: number): number {
  return ((value << by) | (value >>> (32 - by))) >>> 0;
}
