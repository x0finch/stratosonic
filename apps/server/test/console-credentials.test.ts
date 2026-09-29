import { SELF } from "cloudflare:test";
import { account, newRandomId, session, user } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";
import { subsonicToken } from "../src/auth/crypto";
import { createUserWithPassword, setPassword } from "../src/console-auth/credentials";
import { database } from "../src/db";
import { findUserByUsername } from "../src/users/repository";
import { countingD1, expectPasswordInvariant, shape } from "./console-auth-support";
import { BASE, encryptionKey, type JsonEnvelope, testEnv } from "./support";

/**
 * The one credential writer (#81, #89): every way a password is written keeps
 * `user.password` and `account.password` equal, in one D1 batch, and the
 * Subsonic API logs in with whatever was written last.
 */

async function subsonicStatus(userName: string, password: string): Promise<string> {
  const query = new URLSearchParams({
    u: userName,
    t: await subsonicToken(password, "c0ffee"),
    s: "c0ffee",
    v: "1.16.1",
    c: "test",
    f: "json",
  });
  const response = await SELF.fetch(`${BASE}/rest/ping?${query}`);

  return ((await response.json()) as JsonEnvelope)["subsonic-response"].status;
}

/** Writes a console session row for a user, as a sign-in would. */
async function insertSession(userId: string): Promise<string> {
  const id = newRandomId();
  const now = new Date();
  await database(testEnv)
    .insert(session)
    .values({
      id,
      token: newRandomId(),
      userId,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
    });

  return id;
}

async function sessionIds(userId: string): Promise<string[]> {
  const rows = await database(testEnv)
    .select({ id: session.id })
    .from(session)
    .where(eq(session.userId, userId));

  return rows.map((row) => row.id).sort();
}

beforeAll(async () => {
  // The first request an isolate serves runs the first-run bootstrap.
  await SELF.fetch(`${BASE}/rest/getOpenSubsonicExtensions`);
});

describe("the first-run bootstrap", () => {
  it("creates the admin with a credential account carrying the same password", async () => {
    const admin = await findUserByUsername(database(testEnv), "admin");

    expect(admin?.isAdmin).toBe(true);
    await expectPasswordInvariant(admin?.id ?? "", "sesame");
  });
});

describe("createUserWithPassword", () => {
  it("writes the user and the credential account in one batch", async () => {
    const d1 = countingD1(testEnv.DB);

    const id = await createUserWithPassword(drizzle(d1.binding), encryptionKey(), {
      userName: "Alice",
      password: "wonderland",
      isAdmin: false,
      email: "alice@example.com",
    });

    expect(id).toMatch(/^[0-9a-zA-Z]{22}$/);
    expect(d1.roundTrips()).toBe(1);
    expect(d1.statements.map(shape)).toEqual(["insert user", "insert account"]);
    await expectPasswordInvariant(id ?? "", "wonderland");

    const [created] = await database(testEnv)
      .select()
      .from(user)
      .where(eq(user.id, id ?? ""));
    expect(created).toMatchObject({
      userName: "Alice",
      name: "Alice",
      email: "alice@example.com",
      isAdmin: false,
      username: "alice",
      authEmail: "alice@users.invalid",
    });
  });

  it("gives the new user a Subsonic login", async () => {
    await createUserWithPassword(database(testEnv), encryptionKey(), {
      userName: "Bob",
      password: "builder",
      isAdmin: false,
    });

    expect(await subsonicStatus("bob", "builder")).toBe("ok");
  });

  it("writes nothing, and answers null, when the name is taken in any case", async () => {
    const before = await database(testEnv).select().from(account);

    const id = await createUserWithPassword(database(testEnv), encryptionKey(), {
      userName: "ALICE",
      password: "impostor",
      isAdmin: true,
    });

    expect(id).toBeNull();
    expect(await database(testEnv).select().from(account)).toEqual(before);
    expect(await subsonicStatus("alice", "wonderland")).toBe("ok");
  });
});

describe("setPassword", () => {
  let carolId: string;

  beforeAll(async () => {
    carolId =
      (await createUserWithPassword(database(testEnv), encryptionKey(), {
        userName: "Carol",
        password: "first",
        isAdmin: false,
      })) ?? "";
  });

  it("updates both copies, bumps token_epoch and revokes every session, in one batch", async () => {
    await insertSession(carolId);
    await insertSession(carolId);
    const d1 = countingD1(testEnv.DB);

    await setPassword(drizzle(d1.binding), encryptionKey(), carolId, "second");

    expect(d1.roundTrips()).toBe(1);
    expect(d1.statements.map(shape)).toEqual(["update user", "insert account", "delete session"]);
    await expectPasswordInvariant(carolId, "second");
    expect(await sessionIds(carolId)).toEqual([]);

    const [row] = await database(testEnv)
      .select({ tokenEpoch: user.tokenEpoch })
      .from(user)
      .where(eq(user.id, carolId));
    expect(row?.tokenEpoch).toBe(1);
  });

  it("moves the Subsonic login to the new password, and the old one fails", async () => {
    await setPassword(database(testEnv), encryptionKey(), carolId, "third");

    expect(await subsonicStatus("Carol", "third")).toBe("ok");
    expect(await subsonicStatus("Carol", "second")).toBe("failed");
  });

  it("keeps the one session it is told to keep", async () => {
    const kept = await insertSession(carolId);
    await insertSession(carolId);

    await setPassword(database(testEnv), encryptionKey(), carolId, "fourth", {
      keepSessionId: kept,
    });

    expect(await sessionIds(carolId)).toEqual([kept]);
    await expectPasswordInvariant(carolId, "fourth");
  });

  it("leaves every other user's password and sessions alone", async () => {
    const [alice] = await database(testEnv).select().from(user).where(eq(user.userName, "Alice"));
    const aliceSession = await insertSession(alice?.id ?? "");

    await setPassword(database(testEnv), encryptionKey(), carolId, "fifth");

    expect(await sessionIds(alice?.id ?? "")).toEqual([aliceSession]);
    await expectPasswordInvariant(alice?.id ?? "", "wonderland");
  });

  it("gives a user without a credential account one", async () => {
    // A user row written without the credential writer: code older than
    // migration 0008, running between the migration and the deploy.
    const id = newRandomId();
    const now = new Date();
    await database(testEnv)
      .insert(user)
      .values({ id, userName: "Dave", password: "", createdAt: now, updatedAt: now });

    await setPassword(database(testEnv), encryptionKey(), id, "recovered");

    await expectPasswordInvariant(id, "recovered");
    expect(await subsonicStatus("dave", "recovered")).toBe("ok");
  });

  it("writes nothing for a user that does not exist", async () => {
    const before = await database(testEnv).select().from(account);

    await setPassword(database(testEnv), encryptionKey(), newRandomId(), "nobody");

    expect(await database(testEnv).select().from(account)).toEqual(before);
  });
});
