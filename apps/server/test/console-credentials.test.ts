import { SELF } from "cloudflare:test";
import {
  consoleAccount,
  consoleSession,
  consoleUser,
  newRandomId,
  property,
  subsonicUser,
} from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";
import { createConsoleUser, setConsolePassword } from "../src/console-auth/credentials";
import type { Role } from "../src/console-auth/permissions";
import { database } from "../src/db";
import { findUserByUsername } from "../src/users/repository";
import {
  countingD1,
  expectConsolePassword,
  GUEST_ROLE,
  seedConsoleUser,
  shape,
  subsonicPing,
} from "./console-auth-support";
import { BASE, encryptionKey, testEnv } from "./support";

/**
 * The one writer of console users and their passwords (#99): each write is one
 * D1 batch over `user`, `account` and `session`, and never touches a Subsonic
 * user. The first-run bootstrap has created the Subsonic admin `admin` /
 * `sesame` from the bindings in vitest.config.ts. Alice is the console's
 * owner; everyone else has a role that grants nothing.
 */

/** A role no release defines, as the writer's type takes it. */
const GUEST = GUEST_ROLE as Role;

const send = (request: Request) => SELF.fetch(request);

/** Writes a console session row for a console user, as a sign-in would. */
async function insertSession(consoleUserId: string): Promise<string> {
  const id = newRandomId();
  const now = new Date();
  await database(testEnv)
    .insert(consoleSession)
    .values({
      id,
      token: newRandomId(),
      userId: consoleUserId,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
    });

  return id;
}

async function sessionIds(consoleUserId: string): Promise<string[]> {
  const rows = await database(testEnv)
    .select({ id: consoleSession.id })
    .from(consoleSession)
    .where(eq(consoleSession.userId, consoleUserId));

  return rows.map((row) => row.id).sort();
}

function subsonicUsers() {
  return database(testEnv).select().from(subsonicUser);
}

beforeAll(async () => {
  // The first request an isolate serves runs the first-run bootstrap.
  await SELF.fetch(`${BASE}/rest/getOpenSubsonicExtensions`);
});

describe("the first-run bootstrap", () => {
  it("creates the Subsonic admin and no console user", async () => {
    expect((await findUserByUsername(database(testEnv), "admin"))?.isAdmin).toBe(true);
    expect(await database(testEnv).select().from(consoleUser)).toEqual([]);
    expect(await database(testEnv).select().from(consoleAccount)).toEqual([]);
  });
});

describe("createConsoleUser", () => {
  it("writes the console user and its credential account in one batch, and no Subsonic user", async () => {
    const before = await subsonicUsers();
    const d1 = countingD1(testEnv.DB);

    const id = await createConsoleUser(drizzle(d1.binding), encryptionKey(), {
      username: "Alice",
      password: "wonderland",
      role: "owner",
    });

    expect(id).toMatch(/^[0-9a-zA-Z]{22}$/);
    expect(d1.roundTrips()).toBe(1);
    expect(d1.statements.map(shape)).toEqual(["insert user", "insert account"]);
    await expectConsolePassword(id ?? "", "wonderland");
    expect(await subsonicUsers()).toEqual(before);

    const [created] = await database(testEnv)
      .select()
      .from(consoleUser)
      .where(eq(consoleUser.id, id ?? ""));
    expect(created).toMatchObject({
      name: "Alice",
      displayUsername: "Alice",
      username: "alice",
      email: "alice@console.invalid",
      emailVerified: false,
      image: null,
      role: "owner",
    });
  });

  it("gives the console user no Subsonic login", async () => {
    await seedConsoleUser("Bob", "builder", GUEST_ROLE);

    expect(await subsonicPing(send, BASE, "bob", "builder")).toBe(40);
  });

  it("names a console user after a Subsonic user without touching that user", async () => {
    const [before] = await subsonicUsers();

    const id = await createConsoleUser(database(testEnv), encryptionKey(), {
      username: "admin",
      password: "console's own",
      role: GUEST,
    });

    expect(id).not.toBeNull();
    expect(await subsonicUsers()).toEqual([before]);
    expect(await subsonicPing(send, BASE, "admin", "sesame")).toBe("ok");
    expect(await subsonicPing(send, BASE, "admin", "console's own")).toBe(40);
  });

  it("writes nothing, and answers null, when the name is taken in any ASCII case", async () => {
    const before = await database(testEnv).select().from(consoleAccount);

    const id = await createConsoleUser(database(testEnv), encryptionKey(), {
      username: "ALICE",
      password: "impostor",
      role: GUEST,
    });

    expect(id).toBeNull();
    expect(await database(testEnv).select().from(consoleAccount)).toEqual(before);
  });

  it("writes nothing, and answers null, for a second owner: the database takes one", async () => {
    const before = await database(testEnv).select().from(consoleUser);
    const d1 = countingD1(testEnv.DB);

    const id = await createConsoleUser(drizzle(d1.binding), encryptionKey(), {
      username: "Usurper",
      password: "second-owner",
      role: "owner",
    });

    expect(id).toBeNull();
    expect(d1.statements.reduce((sum, statement) => sum + statement.rowsWritten, 0)).toBe(0);
    expect(await database(testEnv).select().from(consoleUser)).toEqual(before);
    const owners = await database(testEnv)
      .select({ username: consoleUser.username })
      .from(consoleUser)
      .where(eq(consoleUser.role, "owner"));
    expect(owners).toEqual([{ username: "alice" }]);
  });

  it("with onlyIfFirstUser, writes nothing once any console user exists, whatever the name", async () => {
    const d1 = countingD1(testEnv.DB);

    const id = await createConsoleUser(
      drizzle(d1.binding),
      encryptionKey(),
      { username: "Mallory", password: "second", role: "owner" },
      { onlyIfFirstUser: true },
    );

    expect(id).toBeNull();
    expect(d1.roundTrips()).toBe(1);
    expect(d1.statements.reduce((sum, statement) => sum + statement.rowsWritten, 0)).toBe(0);
  });

  it("runs the statements alongside in its batch, and rolls back with them", async () => {
    const db = database(testEnv);
    await db.insert(property).values({ id: "credentials-test", value: "taken" });

    // A plain insert of a key that exists fails, and takes the console user
    // with it.
    await expect(
      createConsoleUser(
        db,
        encryptionKey(),
        { username: "Erin", password: "rolled-back", role: GUEST },
        { alongside: () => [db.insert(property).values({ id: "credentials-test", value: "" })] },
      ),
    ).rejects.toThrow();
    expect(await db.select().from(consoleUser).where(eq(consoleUser.username, "erin"))).toEqual([]);

    const id = await createConsoleUser(
      db,
      encryptionKey(),
      { username: "Erin", password: "kept", role: GUEST },
      {
        alongside: (consoleUserId) => [
          db.insert(property).values({ id: `created-${consoleUserId}` }),
        ],
      },
    );
    const marks = await db
      .select()
      .from(property)
      .where(eq(property.id, `created-${id}`));
    expect(marks).toHaveLength(1);
    await expectConsolePassword(id ?? "", "kept");
  });
});

describe("setConsolePassword", () => {
  let carolId: string;

  beforeAll(async () => {
    carolId = await seedConsoleUser("Carol", "first", GUEST_ROLE);
  });

  it("rehashes the password and revokes every session, in one batch", async () => {
    await insertSession(carolId);
    await insertSession(carolId);
    const [before] = await database(testEnv)
      .select({ password: consoleAccount.password })
      .from(consoleAccount)
      .where(eq(consoleAccount.userId, carolId));
    const d1 = countingD1(testEnv.DB);

    await expect(
      setConsolePassword(drizzle(d1.binding), encryptionKey(), carolId, "first"),
    ).resolves.toBe(true);

    expect(d1.roundTrips()).toBe(1);
    expect(d1.statements.map(shape)).toEqual(["update account", "delete session"]);
    // The same password, under a fresh salt.
    await expectConsolePassword(carolId, "first");
    const [after] = await database(testEnv)
      .select({ password: consoleAccount.password })
      .from(consoleAccount)
      .where(eq(consoleAccount.userId, carolId));
    expect(after?.password).not.toBe(before?.password);
    expect(await sessionIds(carolId)).toEqual([]);
  });

  it("moves the console to the new password", async () => {
    await setConsolePassword(database(testEnv), encryptionKey(), carolId, "second");

    await expectConsolePassword(carolId, "second");
  });

  it("keeps the one session it is told to keep", async () => {
    const kept = await insertSession(carolId);
    await insertSession(carolId);

    await setConsolePassword(database(testEnv), encryptionKey(), carolId, "third", {
      keepSessionId: kept,
    });

    expect(await sessionIds(carolId)).toEqual([kept]);
    await expectConsolePassword(carolId, "third");
  });

  it("leaves every other console user's password and sessions alone", async () => {
    const [alice] = await database(testEnv)
      .select()
      .from(consoleUser)
      .where(eq(consoleUser.username, "alice"));
    const aliceSession = await insertSession(alice?.id ?? "");

    await setConsolePassword(database(testEnv), encryptionKey(), carolId, "fourth");

    expect(await sessionIds(alice?.id ?? "")).toEqual([aliceSession]);
    await expectConsolePassword(alice?.id ?? "", "wonderland");
  });

  it("leaves every Subsonic password alone, a namesake's too", async () => {
    const [namesake] = await database(testEnv)
      .select()
      .from(consoleUser)
      .where(eq(consoleUser.username, "admin"));
    const before = await subsonicUsers();

    await setConsolePassword(database(testEnv), encryptionKey(), namesake?.id ?? "", "sesame");

    expect(await subsonicUsers()).toEqual(before);
    expect(await subsonicPing(send, BASE, "admin", "sesame")).toBe("ok");
    await expectConsolePassword(namesake?.id ?? "", "sesame");
  });

  it("writes nothing, and answers false, for a console user that does not exist", async () => {
    const before = await database(testEnv).select().from(consoleAccount);

    await expect(
      setConsolePassword(database(testEnv), encryptionKey(), newRandomId(), "nobody"),
    ).resolves.toBe(false);

    expect(await database(testEnv).select().from(consoleAccount)).toEqual(before);
  });

  it("does not take a Subsonic user's id for a console user's", async () => {
    const admin = await findUserByUsername(database(testEnv), "admin");

    await expect(
      setConsolePassword(database(testEnv), encryptionKey(), admin?.id ?? "", "taken-over"),
    ).resolves.toBe(false);
    expect(await subsonicPing(send, BASE, "admin", "sesame")).toBe("ok");
  });
});
