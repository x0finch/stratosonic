/**
 * The cryptography Subsonic authentication needs, on Web Crypto only.
 *
 * Two primitives live here, both following Navidrome so a password encrypted
 * by either server can be read by the other:
 *
 * - password storage, AES-256-GCM with a random nonce prepended to the
 *   ciphertext and the whole thing base64-encoded (utils/encrypt.go);
 * - the Subsonic token digest `md5(password + salt)`
 *   (server/subsonic/middlewares.go, validateCredentials).
 */

/** AES-GCM's standard nonce size, which is what Go's cipher.NewGCM uses. */
const NONCE_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Derived keys, cached for the life of the isolate: the derivation is pure, and
 * every authenticated request would otherwise repeat it against the Worker's
 * CPU budget.
 */
const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * The AES-256 key for a passphrase: its SHA-256 digest, as Navidrome's
 * `keyTo32Bytes` does before handing the key to AES.
 */
function encryptionKey(passphrase: string): Promise<CryptoKey> {
  const cached = keyCache.get(passphrase);
  if (cached) {
    return cached;
  }

  const key = crypto.subtle
    .digest("SHA-256", encoder.encode(passphrase))
    .then((digest) =>
      crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
    );

  keyCache.set(passphrase, key);
  return key;
}

/** Encrypts a password for storage: base64 of `nonce || ciphertext || tag`. */
export async function encryptPassword(passphrase: string, plaintext: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await encryptionKey(passphrase),
    encoder.encode(plaintext),
  );

  const stored = new Uint8Array(nonce.length + sealed.byteLength);
  stored.set(nonce);
  stored.set(new Uint8Array(sealed), nonce.length);

  return toBase64(stored);
}

/**
 * Recovers a stored password. Throws if the value was encrypted under another
 * passphrase, or is not a password this server wrote.
 */
export async function decryptPassword(passphrase: string, stored: string): Promise<string> {
  const bytes = fromBase64(stored);
  if (bytes.length <= NONCE_BYTES) {
    throw new Error("stored password is too short to be AES-GCM output");
  }

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, NONCE_BYTES) },
    await encryptionKey(passphrase),
    bytes.subarray(NONCE_BYTES),
  );

  return decoder.decode(plaintext);
}

/**
 * The Subsonic token digest, lowercase hex.
 *
 * MD5 is not part of the Web Crypto standard; Workers support it as a
 * documented extension to `crypto.subtle.digest`, which is what lets this run
 * without pulling in an MD5 implementation of our own.
 */
export async function subsonicToken(password: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest("MD5", encoder.encode(password + salt));

  return toHex(new Uint8Array(digest));
}

/**
 * Compares two strings without leaking, through timing, how much of the value
 * the caller got right. The length is not a secret: a token of the wrong length
 * is wrong whatever it contains.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return difference === 0;
}

/** Decodes the `enc:<hex>` form of the `p` parameter; `null` if it is not hex. */
export function decodeHex(value: string): string | null {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) {
    return null;
  }

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }

  return decoder.decode(bytes);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
