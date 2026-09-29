import { SELF } from "cloudflare:test";
import { account, newRandomId, property, session, user } from "@stratosonic/db";
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

  it("with onlyIfFirstUser, writes nothing once any user exists, whatever the name", async () => {
    const d1 = countingD1(testEnv.DB);

    const id = await createUserWithPassword(
      drizzle(d1.binding),
      encryptionKey(),
      { userName: "Mallory", password: "second-admin", isAdmin: true },
      { onlyIfFirstUser: true },
    );

    expect(id).toBeNull();
    expect(d1.roundTrips()).toBe(1);
    expect(d1.statements.reduce((sum, statement) => sum + statement.rowsWritten, 0)).toBe(0);
    expect(await findUserByUsername(database(testEnv), "mallory")).toBeNull();
  });

  it("runs the statements alongside in its batch, and rolls back with them", async () => {
    const db = database(testEnv);
    await db.insert(property).values({ id: "credentials-test", value: "taken" });

    // A plain insert of a key that exists fails, and takes the user with it.
    await expect(
      createUserWithPassword(
        db,
        encryptionKey(),
        { userName: "Erin", password: "rolled-back", isAdmin: false },
        { alongside: () => [db.insert(property).values({ id: "credentials-test", value: "" })] },
      ),
    ).rejects.toThrow();
    expect(await findUserByUsername(db, "erin")).toBeNull();

    const id = await createUserWithPassword(
      db,
      encryptionKey(),
      { userName: "Erin", password: "kept", isAdmin: false },
      { alongside: (userId) => [db.insert(property).values({ id: `created-${userId}` })] },
    );
    const marks = await db
      .select()
      .from(property)
      .where(eq(property.id, `created-${id}`));
    expect(marks).toHaveLength(1);
    await expectPasswordInvariant(id ?? "", "kept");
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

  it("rolls the password and the revocation back when a statement alongside fails", async () => {
    const db = database(testEnv);
    await setPassword(db, encryptionKey(), carolId, "before");
    const kept = await insertSession(carolId);
    await db.insert(property).values({ id: "set-password-test", value: "taken" });

    await expect(
      setPassword(db, encryptionKey(), carolId, "after", {
        alongside: [db.insert(property).values({ id: "set-password-test", value: "" })],
      }),
    ).rejects.toThrow();

    await expectPasswordInvariant(carolId, "before");
    expect(await sessionIds(carolId)).toEqual([kept]);
  });

  it("writes nothing for a user that does not exist", async () => {
    const before = await database(testEnv).select().from(account);

    await expect(
      setPassword(database(testEnv), encryptionKey(), newRandomId(), "nobody"),
    ).resolves.toBe(false);

    expect(await database(testEnv).select().from(account)).toEqual(before);
  });

  it("with onlyIfAdmin, writes nothing of a user who is not an admin", async () => {
    await setPassword(database(testEnv), encryptionKey(), carolId, "unchanged");
    const kept = await insertSession(carolId);
    const d1 = countingD1(testEnv.DB);

    const changed = await setPassword(drizzle(d1.binding), encryptionKey(), carolId, "admin-only", {
      onlyIfAdmin: true,
      alongside: [],
    });

    expect(changed).toBe(false);
    expect(d1.statements.reduce((sum, statement) => sum + statement.rowsWritten, 0)).toBe(0);
    await expectPasswordInvariant(carolId, "unchanged");
    expect(await sessionIds(carolId)).toEqual([kept]);
  });

  it("with onlyIfAdmin, sets an admin's password", async () => {
    const [admin] = await database(testEnv).select().from(user).where(eq(user.userName, "admin"));

    const changed = await setPassword(database(testEnv), encryptionKey(), admin?.id ?? "", "new", {
      onlyIfAdmin: true,
    });

    expect(changed).toBe(true);
    await expectPasswordInvariant(admin?.id ?? "", "new");
  });
});
