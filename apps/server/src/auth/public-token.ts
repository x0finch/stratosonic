/**
 * Signed tokens for the public image URLs, the way Navidrome's
 * `publicurl.ImageURL` signs one artwork id into `/share/img/<token>`
 * (core/publicurl/publicurl.go, server/public/public.go).
 *
 * A token names one artwork id and authorizes exactly that: fetching its
 * image, with no account behind it. That is what lets an image URL be handed
 * to a lock screen, a cast receiver or a chat embed without handing over a
 * credential — a Subsonic `t`/`s` pair never expires and opens every
 * endpoint.
 *
 * The format is fixed rather than a JWT: `b64url(id) "." b64url(mac)`, where
 * `mac` is HMAC-SHA256 over the id. The key is derived with HKDF-SHA256 from
 * `PASSWORD_ENCRYPTION_KEY`, the one secret this Worker already has, under an
 * `info` of its own so it can never coincide with the password-encryption
 * key. Verification is `crypto.subtle.verify`, which compares in constant
 * time.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The HKDF `info` that makes this key this purpose's and no other's. */
const KEY_INFO = "stratosonic/public-image/v1";

/** Derived keys, cached for the life of the isolate: the derivation is pure. */
const keyCache = new Map<string, Promise<CryptoKey>>();

function imageKey(passphrase: string): Promise<CryptoKey> {
  const cached = keyCache.get(passphrase);
  if (cached) {
    return cached;
  }

  const key = crypto.subtle
    .importKey("raw", encoder.encode(passphrase), "HKDF", false, ["deriveKey"])
    .then((base) =>
      crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array(0),
          info: encoder.encode(KEY_INFO),
        },
        base,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign", "verify"],
      ),
    );

  keyCache.set(passphrase, key);
  return key;
}

/** The token for one artwork id. */
export async function signPublicImageToken(passphrase: string, id: string): Promise<string> {
  const payload = encoder.encode(id);
  const mac = await crypto.subtle.sign("HMAC", await imageKey(passphrase), payload);

  return `${toBase64Url(payload)}.${toBase64Url(new Uint8Array(mac))}`;
}

/**
 * The artwork id a token was signed for, or null when it is not a token this
 * key signed — malformed, truncated, or carrying another id than its MAC's.
 */
export async function verifyPublicImageToken(
  passphrase: string,
  token: string,
): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const payload = fromBase64Url(parts[0] ?? "");
  const mac = fromBase64Url(parts[1] ?? "");
  if (payload === null || mac === null || payload.length === 0) {
    return null;
  }

  const valid = await crypto.subtle.verify("HMAC", await imageKey(passphrase), mac, payload);

  return valid ? decoder.decode(payload) : null;
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    return null;
  }

  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}
