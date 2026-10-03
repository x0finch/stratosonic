import { describe, expect, it, vi } from "vitest";
import { PEPPER_INFO } from "../src/console-auth/password-hash";
import {
  CREDENTIALS_INFO,
  openCredentials,
  SEALED_PREFIX,
  sealCredentials,
} from "../src/storage/credentials";
import { encryptionKey } from "./support";

/**
 * A connected library's sealed token (storage/credentials.ts; #84,
 * "Credentials" and "Testing Decisions"): AES-256-GCM under a key HKDF
 * derives from `PASSWORD_ENCRYPTION_KEY`, bound to the library's path.
 *
 * Every credential here is made up.
 */

const TOKEN = {
  accessKeyId: "0123456789abcdef3F9A",
  secretAccessKey: "made+up/secret=access-key-0123456789abcdef",
};
const PATH = "s3://fedcba9876543210fedcba9876543210.r2.cloudflarestorage.com/archive";

const encoder = new TextEncoder();

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function parts(sealed: string): { nonce: Uint8Array; ciphertext: Uint8Array } {
  const [nonce = "", ciphertext = ""] = sealed.slice(SEALED_PREFIX.length).split("$");
  return { nonce: fromBase64(nonce), ciphertext: fromBase64(ciphertext) };
}

/** HKDF-SHA256 over the passphrase with an empty salt, as raw bits. */
async function hkdf(passphrase: string, info: string): Promise<ArrayBuffer> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "HKDF", false, [
    "deriveBits",
  ]);
  return crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(info) },
    material,
    256,
  );
}

/** Opens a sealed value with raw key bits, as the scheme describes, or null. */
async function openWith(bits: ArrayBuffer, sealed: string, path: string): Promise<string | null> {
  const key = await crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["decrypt"]);
  const { nonce, ciphertext } = parts(sealed);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(`library:${path}`) },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

describe("sealCredentials", () => {
  it("writes aes-256-gcm$v1$<12-byte nonce>$<ciphertext>, which openCredentials opens", async () => {
    const sealed = await sealCredentials(encryptionKey(), PATH, TOKEN);

    expect(CREDENTIALS_INFO).toBe("stratosonic/storage-credentials/v1");
    expect(sealed).toMatch(/^aes-256-gcm\$v1\$[A-Za-z0-9+/]{16}\$[A-Za-z0-9+/]+=*$/);
    expect(parts(sealed).nonce).toHaveLength(12);
    expect(await openCredentials(encryptionKey(), PATH, sealed)).toEqual(TOKEN);
  });

  it("is the scheme computed from its description, independently of the module", async () => {
    const sealed = await sealCredentials(encryptionKey(), PATH, TOKEN);
    const opened = await openWith(await hkdf(encryptionKey(), CREDENTIALS_INFO), sealed, PATH);

    expect(JSON.parse(opened ?? "null")).toEqual(TOKEN);
  });

  it("seals under a fresh nonce every time", async () => {
    const first = await sealCredentials(encryptionKey(), PATH, TOKEN);
    const second = await sealCredentials(encryptionKey(), PATH, TOKEN);

    expect(first).not.toBe(second);
    expect(parts(first).nonce).not.toEqual(parts(second).nonce);
    expect(await openCredentials(encryptionKey(), PATH, second)).toEqual(TOKEN);
  });

  it("never contains either value, or logs anything", async () => {
    const logged: unknown[][] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }

    const sealed = await sealCredentials(encryptionKey(), PATH, TOKEN);
    await openCredentials(encryptionKey(), PATH, sealed);
    await openCredentials("another passphrase", PATH, sealed).catch(() => {});

    for (const value of [TOKEN.accessKeyId, TOKEN.secretAccessKey]) {
      expect(sealed).not.toContain(value);
      expect(sealed).not.toContain(btoa(value));
    }
    expect(logged).toEqual([]);
    vi.restoreAllMocks();
  });

  it("refuses an empty passphrase", async () => {
    await expect(sealCredentials("", PATH, TOKEN)).rejects.toThrow(/empty passphrase/);
    const sealed = await sealCredentials(encryptionKey(), PATH, TOKEN);
    await expect(openCredentials("", PATH, sealed)).rejects.toThrow();
  });
});

describe("openCredentials", () => {
  it("fails under another passphrase", async () => {
    const sealed = await sealCredentials(encryptionKey(), PATH, TOKEN);

    await expect(openCredentials(`${encryptionKey()}-rotated`, PATH, sealed)).rejects.toThrow(
      /do not open/,
    );
  });

  it("fails for another library's path: a moved ciphertext does not open", async () => {
    const sealed = await sealCredentials(encryptionKey(), PATH, TOKEN);
    const other = "s3://fedcba9876543210fedcba9876543210.r2.cloudflarestorage.com/other";

    await expect(openCredentials(encryptionKey(), other, sealed)).rejects.toThrow(/do not open/);
    // Re-sealed under the new path, as a path change does, it opens there.
    const resealed = await sealCredentials(
      encryptionKey(),
      other,
      await openCredentials(encryptionKey(), PATH, sealed),
    );
    expect(await openCredentials(encryptionKey(), other, resealed)).toEqual(TOKEN);
  });

  it("refuses a value that is not one this scheme wrote, without echoing it", async () => {
    const sealed = await sealCredentials(encryptionKey(), PATH, TOKEN);
    const { nonce, ciphertext } = parts(sealed);
    const tampered = new Uint8Array(ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

    for (const value of [
      "",
      TOKEN.secretAccessKey,
      `aes-256-gcm$v2$${b64(nonce)}$${b64(ciphertext)}`,
      `${SEALED_PREFIX}${b64(nonce)}`,
      `${SEALED_PREFIX}${b64(nonce.subarray(1))}$${b64(ciphertext)}`,
      `${SEALED_PREFIX}${b64(nonce)}$${b64(ciphertext.subarray(0, 8))}`,
      `${SEALED_PREFIX}${b64(nonce)}$${b64(tampered)}`,
      `${SEALED_PREFIX}not base64!$${b64(ciphertext)}`,
    ]) {
      const error = await openCredentials(encryptionKey(), PATH, value).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(TOKEN.secretAccessKey);
    }
  });

  it("refuses a sealed value that does not hold a token", async () => {
    // Sealed by hand, under the right key and path, over the wrong JSON.
    const bits = await hkdf(encryptionKey(), CREDENTIALS_INFO);
    const key = await crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt"]);
    for (const json of ['{"accessKeyId":"a"}', '{"accessKeyId":"","secretAccessKey":"b"}', "[]"]) {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(`library:${PATH}`) },
        key,
        encoder.encode(json),
      );
      const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
      const sealed = `${SEALED_PREFIX}${b64(nonce)}$${b64(new Uint8Array(ciphertext))}`;

      await expect(openCredentials(encryptionKey(), PATH, sealed)).rejects.toThrow(/hold a token/);
    }
  });
});

describe("the credentials key", () => {
  it("differs from the pepper, session, image and Subsonic password keys", async () => {
    const passphrase = encryptionKey();
    const sealed = await sealCredentials(passphrase, PATH, TOKEN);
    const others = {
      pepper: await hkdf(passphrase, PEPPER_INFO),
      session: await hkdf(passphrase, "stratosonic/console-session-secret/v1"),
      image: await hkdf(passphrase, "stratosonic/public-image/v1"),
      // ADR-0003: the Subsonic password key is a plain SHA-256.
      subsonic: await crypto.subtle.digest("SHA-256", encoder.encode(passphrase)),
    };
    const own = new Uint8Array(await hkdf(passphrase, CREDENTIALS_INFO));

    for (const [name, bits] of Object.entries(others)) {
      expect(new Uint8Array(bits), name).not.toEqual(own);
      expect(await openWith(bits, sealed, PATH), name).toBeNull();
    }
  });
});
