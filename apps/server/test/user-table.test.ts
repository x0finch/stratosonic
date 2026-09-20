import { env } from "cloudflare:test";
import { encodeId, newRandomId, user } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { database } from "../src/db";

function newUser(userName: string) {
  const now = new Date(1_700_000_000_000);
  return {
    id: newRandomId(),
    userName,
    name: "Admin",
    email: "",
    password: "ciphertext",
    isAdmin: true,
    createdAt: now,
    updatedAt: now,
  };
}

describe("the user table", () => {
  it("round-trips a user through Drizzle", async () => {
    const db = database(env);
    const inserted = newUser("round-trip");

    await db.insert(user).values(inserted);
    const [stored] = await db.select().from(user).where(eq(user.id, inserted.id));

    expect(stored).toMatchObject({
      id: inserted.id,
      userName: "round-trip",
      name: "Admin",
      email: "",
      password: "ciphertext",
      isAdmin: true,
    });
    expect(stored?.createdAt).toEqual(inserted.createdAt);
    expect(stored?.updatedAt).toEqual(inserted.updatedAt);
  });

  it("defaults the optional columns the way Navidrome's table does", async () => {
    const db = database(env);
    const now = new Date();
    const id = newRandomId();

    await db.insert(user).values({ id, userName: "defaults", createdAt: now, updatedAt: now });
    const [stored] = await db.select().from(user).where(eq(user.id, id));

    expect(stored).toMatchObject({
      name: "",
      email: "",
      password: "",
      isAdmin: false,
      tokenEpoch: 0,
      lastLoginAt: null,
      lastAccessAt: null,
    });
  });

  it("rejects a second user whose name differs only in case", async () => {
    const db = database(env);

    await db.insert(user).values(newUser("Unique"));

    await expect(db.insert(user).values(newUser("uNIQUE"))).rejects.toThrow();
  });
});

describe("newRandomId", () => {
  it("mints 22-character base62 ids", () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      expect(newRandomId()).toMatch(/^[0-9a-zA-Z]{22}$/);
    }
  });

  it("does not repeat itself", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newRandomId()));

    expect(ids.size).toBe(1000);
  });
});

describe("encodeId", () => {
  it.each([
    ["all-zero bytes", new Uint8Array(16), "0".repeat(22)],
    ["the value one", Uint8Array.from([...new Array(15).fill(0), 1]), "0000000000000000000001"],
    ["all-one bytes", new Uint8Array(16).fill(0xff), "7N42dgm5tFLK9N8MT7fHC7"],
  ])("renders %s the way Go renders them in base62", (_label, bytes, expected) => {
    expect(encodeId(bytes)).toBe(expected);
  });

  it("refuses anything that is not 16 bytes", () => {
    expect(() => encodeId(new Uint8Array(15))).toThrow();
  });
});
