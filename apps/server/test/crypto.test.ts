import { describe, expect, it } from "vitest";
import {
  constantTimeEquals,
  decodeHex,
  decryptPassword,
  encryptPassword,
  subsonicToken,
} from "../src/auth/crypto";

const PASSPHRASE = "a-test-encryption-key";

describe("password encryption", () => {
  it("round-trips a password", async () => {
    const stored = await encryptPassword(PASSPHRASE, "sesame");

    await expect(decryptPassword(PASSPHRASE, stored)).resolves.toBe("sesame");
  });

  it("round-trips a password with non-ASCII characters", async () => {
    const password = "pässwörd-音楽-🎵";
    const stored = await encryptPassword(PASSPHRASE, password);

    await expect(decryptPassword(PASSPHRASE, stored)).resolves.toBe(password);
  });

  it("stores base64 and never the plaintext", async () => {
    const stored = await encryptPassword(PASSPHRASE, "sesame");

    expect(stored).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(stored).not.toContain("sesame");
  });

  it("uses a fresh nonce, so the same password encrypts differently each time", async () => {
    const first = await encryptPassword(PASSPHRASE, "sesame");
    const second = await encryptPassword(PASSPHRASE, "sesame");

    expect(first).not.toBe(second);
    await expect(decryptPassword(PASSPHRASE, second)).resolves.toBe("sesame");
  });

  it("refuses a password encrypted under another passphrase", async () => {
    const stored = await encryptPassword(PASSPHRASE, "sesame");

    await expect(decryptPassword("another-key", stored)).rejects.toThrow();
  });

  it("refuses a value that is not AES-GCM output", async () => {
    await expect(decryptPassword(PASSPHRASE, "")).rejects.toThrow();
    await expect(decryptPassword(PASSPHRASE, btoa("short"))).rejects.toThrow();
  });
});

describe("the Subsonic token digest", () => {
  it("matches the reference vector", async () => {
    await expect(subsonicToken("sesame", "c19b2d")).resolves.toBe(
      "26719a1196d2a940705a59634eb18eab",
    );
  });

  it("is lowercase hex of 128 bits", async () => {
    await expect(subsonicToken("sesame", "another-salt")).resolves.toMatch(/^[0-9a-f]{32}$/);
  });

  it("changes with the salt", async () => {
    const first = await subsonicToken("sesame", "c19b2d");
    const second = await subsonicToken("sesame", "c19b2e");

    expect(first).not.toBe(second);
  });
});

describe("constantTimeEquals", () => {
  it.each([
    ["equal strings", "abc", "abc", true],
    ["different strings of equal length", "abc", "abd", false],
    ["strings of different lengths", "abc", "abcd", false],
    ["empty strings", "", "", true],
  ])("compares %s", (_label, a, b, expected) => {
    expect(constantTimeEquals(a, b)).toBe(expected);
  });
});

describe("decodeHex", () => {
  it("decodes the hex a client sends as p=enc:<hex>", () => {
    expect(decodeHex("736573616d65")).toBe("sesame");
  });

  it("decodes uppercase hex", () => {
    expect(decodeHex("736573616D65")).toBe("sesame");
  });

  it.each([
    ["an odd number of digits", "abc"],
    ["a non-hex character", "zz"],
  ])("returns null for %s", (_label, value) => {
    expect(decodeHex(value)).toBeNull();
  });
});
