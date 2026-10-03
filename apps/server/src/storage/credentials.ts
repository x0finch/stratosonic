/**
 * A connected library's R2 API token, sealed for D1 (#84, "Credentials";
 * ADR-0009).
 *
 * A library other than the bound bucket is reached through the S3 API, so
 * the Worker must keep its token: an Access Key ID and a Secret Access Key
 * with Object Read & Write on that one bucket. It is stored in
 * `library.credentials` under AES-256-GCM, never in the clear:
 *
 * - **The key** is HKDF-SHA256 over `PASSWORD_ENCRYPTION_KEY`, with an empty
 *   salt and the `info` `stratosonic/storage-credentials/v1`, to a 256-bit
 *   AES-GCM key. It sits beside the console's password pepper (ADR-0007),
 *   its session secret and the public image key, each under an `info` of its
 *   own; the Subsonic password key is a plain SHA-256 of the passphrase
 *   (ADR-0003). So no two of them are ever the same key. It is derived once
 *   per isolate, and an empty passphrase, a key anybody could derive, is
 *   refused.
 * - **The stored value** is `aes-256-gcm$v1$<nonce>$<ciphertext>`, both
 *   standard base64, over the JSON `{"accessKeyId","secretAccessKey"}`, with
 *   a fresh 12-byte nonce on every write. The ciphertext carries GCM's tag.
 * - **The additional authenticated data** is `library:<path>`, the library's
 *   storage URI (`s3://<endpoint host>/<bucket>`). A sealed token copied onto
 *   another library's row will not open there, so a change of `path` (a new
 *   account or bucket) re-seals the token under the new path in the same
 *   batch.
 *
 * Rotating `PASSWORD_ENCRYPTION_KEY` makes every sealed token unreadable, as
 * it makes the Subsonic passwords: such a library then reports `auth`
 * (storage/s3.ts), and the console asks for its token again. Neither value is
 * ever logged or answered; the console sees an Access Key ID hint at most.
 */

/** The HKDF `info` the credentials key is derived under. */
export const CREDENTIALS_INFO = "stratosonic/storage-credentials/v1";

/** The scheme and version a sealed value starts with. */
export const SEALED_PREFIX = "aes-256-gcm$v1$";

/** AES-GCM's standard nonce size. */
const NONCE_BYTES = 12;

/** GCM's tag, which every ciphertext ends with. */
const TAG_BYTES = 16;

/** An R2 API token as the S3 API signs with it. */
export interface StorageCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Derived keys, cached for the life of the isolate as the other derivations
 * are (auth/public-token.ts, console-auth/password-hash.ts): the derivation is
 * pure, and every request that opens a token would otherwise repeat it.
 */
const keyCache = new Map<string, Promise<CryptoKey>>();

function credentialsKey(passphrase: string): Promise<CryptoKey> {
  const cached = keyCache.get(passphrase);
  if (cached) {
    return cached;
  }

  if (passphrase === "") {
    return Promise.reject(
      new Error("refusing to derive the storage credentials key from an empty passphrase"),
    );
  }

  const key = crypto.subtle
    .importKey("raw", encoder.encode(passphrase), "HKDF", false, ["deriveKey"])
    .then((material) =>
      crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array(0),
          info: encoder.encode(CREDENTIALS_INFO),
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ),
    );

  keyCache.set(passphrase, key);
  return key;
}

/** The additional authenticated data that binds a sealed token to its library. */
function associatedData(path: string): Uint8Array {
  return encoder.encode(`library:${path}`);
}

/**
 * Seals a token for the library whose storage URI is `path`, under a fresh
 * nonce, as `library.credentials` stores it.
 */
export async function sealCredentials(
  passphrase: string,
  path: string,
  credentials: StorageCredentials,
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const plaintext = JSON.stringify({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
  });
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: associatedData(path) },
    await credentialsKey(passphrase),
    encoder.encode(plaintext),
  );

  return `${SEALED_PREFIX}${toBase64(nonce)}$${toBase64(new Uint8Array(sealed))}`;
}

/**
 * The token sealed in `sealed` for the library whose storage URI is `path`.
 * Throws when the value is not one this scheme wrote, was sealed under
 * another passphrase or for another path, or does not hold a token. The
 * error never carries the value or the token.
 */
export async function openCredentials(
  passphrase: string,
  path: string,
  sealed: string,
): Promise<StorageCredentials> {
  const parts = sealed.startsWith(SEALED_PREFIX)
    ? sealed.slice(SEALED_PREFIX.length).split("$")
    : [];
  const nonce = parts.length === 2 ? fromBase64(parts[0] ?? "") : null;
  const ciphertext = parts.length === 2 ? fromBase64(parts[1] ?? "") : null;
  if (
    nonce === null ||
    ciphertext === null ||
    nonce.length !== NONCE_BYTES ||
    ciphertext.length < TAG_BYTES
  ) {
    throw new Error("the stored credentials are not a sealed token this server wrote");
  }

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: associatedData(path) },
      await credentialsKey(passphrase),
      ciphertext,
    );
  } catch (cause) {
    throw new Error(
      "the stored credentials do not open: another key, or sealed for another library",
      // An empty passphrase's refusal says why; a failed decrypt says nothing
      // more than this, and neither carries a secret.
      { cause },
    );
  }

  const credentials = parseCredentials(decoder.decode(plaintext));
  if (credentials === null) {
    throw new Error("the stored credentials do not hold a token");
  }

  return credentials;
}

function parseCredentials(json: string): StorageCredentials | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { accessKeyId, secretAccessKey } = value as Record<string, unknown>;
  if (
    typeof accessKeyId !== "string" ||
    typeof secretAccessKey !== "string" ||
    accessKeyId === "" ||
    secretAccessKey === ""
  ) {
    return null;
  }

  return { accessKeyId, secretAccessKey };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null;
  }
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}
