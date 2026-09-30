/**
 * How console users' passwords are stored (#99, ADR-0007): a peppered
 * HMAC-SHA256, not a slow hash, and not the reversible AES-GCM of Subsonic
 * passwords.
 *
 * A console user's password never has to be recovered: nothing but the
 * console signs in with it, and the console only compares. So it is hashed, one way. A slow
 * hash does not fit the Workers Free plan's 10 ms of CPU a request: PBKDF2-
 * SHA256 measured about 10 ms at 10,000 iterations and 77 ms at 100,000, and
 * Better Auth's default, scrypt, about 100 ms. Instead:
 *
 * - the digest is HMAC-SHA256 over `salt || UTF-8(password)`,
 * - the salt is 16 random bytes, new for every password written, so two
 *   accounts with one password store different digests,
 * - the HMAC key is a pepper, derived by HKDF-SHA256 from
 *   `PASSWORD_ENCRYPTION_KEY` under an `info` of its own, and never stored.
 *
 * Without the key a leaked database is useless: every digest is keyed by a
 * secret the database does not hold, so there is nothing to guess against.
 * That is the trust boundary the Subsonic passwords already have (ADR-0003),
 * whose AES key comes from the same passphrase under a different derivation.
 * With the key as well, a guess at one password costs one HMAC, where a slow
 * hash would have made it costly: the trade-off ADR-0007 records.
 *
 * A stored hash is `hmac-sha256$v1$<salt>$<digest>`, both parts standard
 * base64, so a later scheme can be told apart from this one and verified
 * alongside it.
 */

/**
 * The HKDF `info` the pepper is derived under. It differs from the session
 * secret's (console-auth/auth.ts), and the AES key is a plain SHA-256 of the
 * passphrase (auth/crypto.ts), so no two of them are ever equal.
 */
export const PEPPER_INFO = "stratosonic/console-password-pepper/v1";

/** The scheme and version a stored hash starts with. */
export const HASH_PREFIX = "hmac-sha256$v1$";

/** The salt's length, in bytes. */
export const SALT_BYTES = 16;

/** HMAC-SHA256's output length, in bytes. */
const DIGEST_BYTES = 32;

const encoder = new TextEncoder();

/**
 * The pepper for a passphrase, as an HMAC key, cached for the life of the
 * isolate: the derivation is pure, and every sign-in would otherwise repeat
 * it. It is cached as auth/crypto.ts caches the AES key.
 */
const pepperCache = new Map<string, Promise<CryptoKey>>();

function pepper(passphrase: string): Promise<CryptoKey> {
  const cached = pepperCache.get(passphrase);
  if (cached) {
    return cached;
  }

  // An empty passphrase would be a pepper anybody can compute. The console's
  // middleware refuses to run without the key, so this is a last guard.
  if (passphrase === "") {
    return Promise.reject(
      new Error("refusing to derive the console password pepper from an empty passphrase"),
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
          info: encoder.encode(PEPPER_INFO),
        },
        material,
        { name: "HMAC", hash: "SHA-256", length: DIGEST_BYTES * 8 },
        false,
        ["sign"],
      ),
    );

  pepperCache.set(passphrase, key);
  return key;
}

/** HMAC-SHA256 of `salt || UTF-8(password)` under the pepper. */
async function digest(passphrase: string, salt: Uint8Array, password: string): Promise<Uint8Array> {
  const encoded = encoder.encode(password);
  const message = new Uint8Array(salt.length + encoded.length);
  message.set(salt);
  message.set(encoded, salt.length);

  return new Uint8Array(await crypto.subtle.sign("HMAC", await pepper(passphrase), message));
}

/** Hashes a console password for storage, under a fresh random salt. */
export async function hashConsolePassword(passphrase: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));

  return `${HASH_PREFIX}${toBase64(salt)}$${toBase64(await digest(passphrase, salt, password))}`;
}

/**
 * Whether `password` is the one `stored` was hashed from. The digests are
 * compared in constant time, so the timing says nothing about how many of
 * its bytes a guess got right. A value that is not a hash this scheme wrote,
 * or one written under another key, matches nothing.
 */
export async function verifyConsolePassword(
  passphrase: string,
  stored: string,
  password: string,
): Promise<boolean> {
  const parsed = parse(stored);
  if (parsed === null) {
    return false;
  }

  return constantTimeEqualBytes(await digest(passphrase, parsed.salt, password), parsed.digest);
}

/** The salt and digest of a stored hash, or `null` if it is not one. */
function parse(stored: string): { salt: Uint8Array; digest: Uint8Array } | null {
  if (!stored.startsWith(HASH_PREFIX)) {
    return null;
  }

  const parts = stored.slice(HASH_PREFIX.length).split("$");
  if (parts.length !== 2) {
    return null;
  }

  const salt = fromBase64(parts[0] ?? "");
  const hashed = fromBase64(parts[1] ?? "");
  if (salt?.length !== SALT_BYTES || hashed?.length !== DIGEST_BYTES) {
    return null;
  }

  return { salt, digest: hashed };
}

/**
 * Compares two byte strings in time that depends on their length alone,
 * which is public: every digest is `DIGEST_BYTES` long.
 */
function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }

  return difference === 0;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}
