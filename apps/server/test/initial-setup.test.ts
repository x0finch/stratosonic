import { SELF } from "cloudflare:test";
import { property, user } from "@stratosonic/db";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptPassword, subsonicToken } from "../src/auth/crypto";
import { database } from "../src/db";
import { runInitialSetup } from "../src/setup/initial-setup";
import { BASE, encryptionKey, type JsonEnvelope, testEnv } from "./support";

/**
 * This file owns its database: it asserts what a *first* run does, and the test
 * harness shares D1 between the tests of a file but not across files, so no
 * other file may have written a user first.
 *
 * `INITIAL_USER` and `INITIAL_PASSWORD` come from the bindings in
 * vitest.config.ts, standing in for the var and the secret in production.
 */

const INITIAL_USER = "admin";
const INITIAL_PASSWORD = "sesame";

function users() {
  return database(testEnv).select().from(user);
}

beforeAll(async () => {
  // Any request is enough: the bootstrap runs on the first one an isolate
  // serves.
  await SELF.fetch(`${BASE}/rest/getOpenSubsonicExtensions`);
});

describe("the first run", () => {
  it("creates exactly one user, an admin, from the environment", async () => {
    const created = await users();

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ userName: INITIAL_USER, name: INITIAL_USER, isAdmin: true });
  });

  it("gives that user a random 22-character base62 id", async () => {
    const [created] = await users();

    expect(created?.id).toMatch(/^[0-9a-zA-Z]{22}$/);
  });

  it("stores the password encrypted, not in plaintext", async () => {
    const [created] = await users();

    expect(created?.password).not.toContain(INITIAL_PASSWORD);
    await expect(decryptPassword(encryptionKey(), created?.password ?? "")).resolves.toBe(
      INITIAL_PASSWORD,
    );
  });

  it("sets the initial-setup flag", async () => {
    const flags = await database(testEnv).select().from(property);

    expect(flags).toHaveLength(1);
    expect(flags[0]?.id).toBe("InitialSetup");
    expect(flags[0]?.value).not.toBe("");
  });

  it("leaves a user who can log in", async () => {
    const salt = "c19b2d";
    const query = new URLSearchParams({
      u: INITIAL_USER,
      t: await subsonicToken(INITIAL_PASSWORD, salt),
      s: salt,
      v: "1.16.1",
      c: "Substreamer",
      f: "json",
    });
    const body = (await (await SELF.fetch(`${BASE}/rest/ping?${query}`)).json()) as JsonEnvelope;

    expect(body["subsonic-response"].status).toBe("ok");
  });
});

describe("a second run", () => {
  it("neither duplicates nor overwrites the user", async () => {
    const [before] = await users();

    // What a second isolate, or a restarted Worker, does: the isolate-level
    // cache is empty there, so the bootstrap runs again against a database that
    // has already been set up.
    await runInitialSetup(testEnv);

    const after = await users();
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before);
  });

  it("does not move the initial-setup flag", async () => {
    const [before] = await database(testEnv).select().from(property);

    await runInitialSetup(testEnv);

    const [after] = await database(testEnv).select().from(property);
    expect(after).toEqual(before);
  });

  it("does not recreate the user after it has been deleted", async () => {
    const db = database(testEnv);
    const [existing] = await users();
    await db.delete(user);

    await runInitialSetup(testEnv);

    expect(await users()).toHaveLength(0);

    // Put the fixture back for whatever runs next in this file.
    if (existing) {
      await db.insert(user).values(existing);
    }
  });
});

describe("when the environment does not say what to create", () => {
  it("creates nothing and leaves the flag unset, so a later run can still do it", async () => {
    const db = database(testEnv);
    const [existing] = await users();
    const [flag] = await db.select().from(property);
    await db.delete(user);
    await db.delete(property);

    await runInitialSetup({ ...testEnv, INITIAL_PASSWORD: undefined });

    expect(await users()).toHaveLength(0);
    expect(await db.select().from(property)).toHaveLength(0);

    // Put the fixture back for whatever runs next in this file.
    if (existing) await db.insert(user).values(existing);
    if (flag) await db.insert(property).values(flag);
  });
});
