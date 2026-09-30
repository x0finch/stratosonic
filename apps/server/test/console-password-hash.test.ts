import { describe, expect, it } from "vitest";
import { encryptPassword } from "../src/auth/crypto";
import {
  HASH_PREFIX,
  hashConsolePassword,
  PEPPER_INFO,
  SALT_BYTES,
  verifyConsolePassword,
} from "../src/console-auth/password-hash";
import { encryptionKey } from "./support";

/**
 * How a console user's password is stored (#99, ADR-0007): HMAC-SHA256
 * over a per-password salt and the password, keyed by a pepper that HKDF
 * derives from `PASSWORD_ENCRYPTION_KEY`, in a versioned format.
 */

const encoder = new TextEncoder();

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** The scheme computed from its description, independently of the module. */
async function expectedDigest(passphrase: string, salt: Uint8Array, password: string) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "HKDF", false, [
    "deriveBits",
  ]);
  const pepper = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(PEPPER_INFO) },
    material,
    256,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    pepper,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = new Uint8Array([...salt, ...encoder.encode(password)]);

  return new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
}

describe("hashConsolePassword", () => {
  it("writes hmac-sha256$v1$<16-byte salt>$<32-byte digest>, in base64", async () => {
    const stored = await hashConsolePassword(encryptionKey(), "correct horse");

    expect(PEPPER_INFO).toBe("stratosonic/console-password-pepper/v1");
    expect(stored).toMatch(/^hmac-sha256\$v1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/);
    const [salt = "", digest = ""] = stored.slice(HASH_PREFIX.length).split("$");
    expect(fromBase64(salt)).toHaveLength(SALT_BYTES);
    expect(fromBase64(digest)).toEqual(
      await expectedDigest(encryptionKey(), fromBase64(salt), "correct horse"),
    );
  });

  it("salts every hash afresh, so one password never stores the same value twice", async () => {
    const first = await hashConsolePassword(encryptionKey(), "same");
    const second = await hashConsolePassword(encryptionKey(), "same");

    expect(first).not.toBe(second);
    expect(first.split("$")[2]).not.toBe(second.split("$")[2]);
  });

  it("never contains the password", async () => {
    const stored = await hashConsolePassword(encryptionKey(), "plain-to-see");

    expect(stored).not.toContain("plain-to-see");
    expect(stored).not.toContain(btoa("plain-to-see"));
  });

  it("refuses an empty passphrase", async () => {
    await expect(hashConsolePassword("", "pw")).rejects.toThrow(/empty passphrase/);
  });
});

describe("verifyConsolePassword", () => {
  it("accepts the password a hash was made from, and nothing else", async () => {
    const stored = await hashConsolePassword(encryptionKey(), "wonderland");

    expect(await verifyConsolePassword(encryptionKey(), stored, "wonderland")).toBe(true);
    expect(await verifyConsolePassword(encryptionKey(), stored, "Wonderland")).toBe(false);
    expect(await verifyConsolePassword(encryptionKey(), stored, "wonderland ")).toBe(false);
    expect(await verifyConsolePassword(encryptionKey(), stored, "")).toBe(false);
  });

  it("takes any Unicode and the longest password, byte for byte", async () => {
    const password = `Ünïcødé 🎵 ${"p".repeat(1000)}`;
    const stored = await hashConsolePassword(encryptionKey(), password);

    expect(await verifyConsolePassword(encryptionKey(), stored, password)).toBe(true);
    expect(await verifyConsolePassword(encryptionKey(), stored, password.normalize("NFD"))).toBe(
      false,
    );
  });

  it("matches nothing under another key: the database alone is not enough", async () => {
    const stored = await hashConsolePassword(encryptionKey(), "wonderland");

    expect(await verifyConsolePassword("another-passphrase", stored, "wonderland")).toBe(false);
  });

  it.each([
    ["an empty value", async () => ""],
    ["a Subsonic AES-GCM ciphertext", () => encryptPassword(encryptionKey(), "wonderland")],
    ["another scheme", async () => "scrypt$v1$AAAA$BBBB"],
    ["another version", async () => (await good()).replace("$v1$", () => "$v2$")],
    ["a missing digest", async () => (await good()).split("$").slice(0, 3).join("$")],
    ["an extra part", async () => `${await good()}$AAAA`],
    ["a short salt", async () => (await good()).replace(/\$v1\$[^$]+/, () => "$v1$AAAA")],
    ["a short digest", async () => (await good()).replace(/[^$]+$/, () => "AAAA")],
    [
      "a digest that is not base64",
      async () => (await good()).replace(/[^$]+$/, () => "!".repeat(44)),
    ],
  ])("matches nothing with %s", async (_, stored) => {
    expect(await verifyConsolePassword(encryptionKey(), await stored(), "wonderland")).toBe(false);
  });
});

function good(): Promise<string> {
  return hashConsolePassword(encryptionKey(), "wonderland");
}
