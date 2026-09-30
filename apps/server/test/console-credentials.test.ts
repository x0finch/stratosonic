import { SELF } from "cloudflare:test";
import {
  newRandomId,
  operator,
  operatorAccount,
  operatorSession,
  property,
  user,
} from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";
import { createOperator, setOperatorPassword } from "../src/console-auth/credentials";
import { database } from "../src/db";
import { findUserByUsername } from "../src/users/repository";
import {
  countingD1,
  expectOperatorPassword,
  seedOperator,
  shape,
  subsonicPing,
} from "./console-auth-support";
import { BASE, encryptionKey, testEnv } from "./support";

/**
 * The one writer of operators and their passwords (#99): each write is one D1
 * batch over `operator`, `operator_account` and `operator_session`, and never
 * touches a Subsonic user. The first-run bootstrap has created the Subsonic
 * admin `admin` / `sesame` from the bindings in vitest.config.ts.
 */

const send = (request: Request) => SELF.fetch(request);

/** Writes a console session row for an operator, as a sign-in would. */
async function insertSession(operatorId: string): Promise<string> {
  const id = newRandomId();
  const now = new Date();
  await database(testEnv)
    .insert(operatorSession)
    .values({
      id,
      token: newRandomId(),
      userId: operatorId,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
    });

  return id;
}

async function sessionIds(operatorId: string): Promise<string[]> {
  const rows = await database(testEnv)
    .select({ id: operatorSession.id })
    .from(operatorSession)
    .where(eq(operatorSession.userId, operatorId));

  return rows.map((row) => row.id).sort();
}

function subsonicUsers() {
  return database(testEnv).select().from(user);
}

beforeAll(async () => {
  // The first request an isolate serves runs the first-run bootstrap.
  await SELF.fetch(`${BASE}/rest/getOpenSubsonicExtensions`);
});

describe("the first-run bootstrap", () => {
  it("creates the Subsonic admin and no operator", async () => {
    expect((await findUserByUsername(database(testEnv), "admin"))?.isAdmin).toBe(true);
    expect(await database(testEnv).select().from(operator)).toEqual([]);
    expect(await database(testEnv).select().from(operatorAccount)).toEqual([]);
  });
});

describe("createOperator", () => {
  it("writes the operator and its credential account in one batch, and no Subsonic user", async () => {
    const before = await subsonicUsers();
    const d1 = countingD1(testEnv.DB);

    const id = await createOperator(drizzle(d1.binding), encryptionKey(), {
      username: "Alice",
      password: "wonderland",
    });

    expect(id).toMatch(/^[0-9a-zA-Z]{22}$/);
    expect(d1.roundTrips()).toBe(1);
    expect(d1.statements.map(shape)).toEqual(["insert operator", "insert operator_account"]);
    await expectOperatorPassword(id ?? "", "wonderland");
    expect(await subsonicUsers()).toEqual(before);

    const [created] = await database(testEnv)
      .select()
      .from(operator)
      .where(eq(operator.id, id ?? ""));
    expect(created).toMatchObject({
      name: "Alice",
      displayUsername: "Alice",
      username: "alice",
      email: "alice@console.invalid",
      emailVerified: false,
      image: null,
    });
  });

  it("gives the operator no Subsonic login", async () => {
    await seedOperator("Bob", "builder");

    expect(await subsonicPing(send, BASE, "bob", "builder")).toBe(40);
  });

  it("names an operator after a Subsonic user without touching that user", async () => {
    const [before] = await subsonicUsers();

    const id = await createOperator(database(testEnv), encryptionKey(), {
      username: "admin",
      password: "operator's own",
    });

    expect(id).not.toBeNull();
    expect(await subsonicUsers()).toEqual([before]);
    expect(await subsonicPing(send, BASE, "admin", "sesame")).toBe("ok");
    expect(await subsonicPing(send, BASE, "admin", "operator's own")).toBe(40);
  });

  it("writes nothing, and answers null, when the name is taken in any ASCII case", async () => {
    const before = await database(testEnv).select().from(operatorAccount);

    const id = await createOperator(database(testEnv), encryptionKey(), {
      username: "ALICE",
      password: "impostor",
    });

    expect(id).toBeNull();
    expect(await database(testEnv).select().from(operatorAccount)).toEqual(before);
  });

  it("with onlyIfFirstOperator, writes nothing once any operator exists, whatever the name", async () => {
    const d1 = countingD1(testEnv.DB);

    const id = await createOperator(
      drizzle(d1.binding),
      encryptionKey(),
      { username: "Mallory", password: "second" },
      { onlyIfFirstOperator: true },
    );

    expect(id).toBeNull();
    expect(d1.roundTrips()).toBe(1);
    expect(d1.statements.reduce((sum, statement) => sum + statement.rowsWritten, 0)).toBe(0);
  });

  it("runs the statements alongside in its batch, and rolls back with them", async () => {
    const db = database(testEnv);
    await db.insert(property).values({ id: "credentials-test", value: "taken" });

    // A plain insert of a key that exists fails, and takes the operator with it.
    await expect(
      createOperator(
        db,
        encryptionKey(),
        { username: "Erin", password: "rolled-back" },
        { alongside: () => [db.insert(property).values({ id: "credentials-test", value: "" })] },
      ),
    ).rejects.toThrow();
    expect(await db.select().from(operator).where(eq(operator.username, "erin"))).toEqual([]);

    const id = await createOperator(
      db,
      encryptionKey(),
      { username: "Erin", password: "kept" },
      { alongside: (operatorId) => [db.insert(property).values({ id: `created-${operatorId}` })] },
    );
    const marks = await db
      .select()
      .from(property)
      .where(eq(property.id, `created-${id}`));
    expect(marks).toHaveLength(1);
    await expectOperatorPassword(id ?? "", "kept");
  });
});

describe("setOperatorPassword", () => {
  let carolId: string;

  beforeAll(async () => {
    carolId = await seedOperator("Carol", "first");
  });

  it("rehashes the password and revokes every session, in one batch", async () => {
    await insertSession(carolId);
    await insertSession(carolId);
    const [before] = await database(testEnv)
      .select({ password: operatorAccount.password })
      .from(operatorAccount)
      .where(eq(operatorAccount.userId, carolId));
    const d1 = countingD1(testEnv.DB);

    await expect(
      setOperatorPassword(drizzle(d1.binding), encryptionKey(), carolId, "first"),
    ).resolves.toBe(true);

    expect(d1.roundTrips()).toBe(1);
    expect(d1.statements.map(shape)).toEqual([
      "update operator_account",
      "delete operator_session",
    ]);
    // The same password, under a fresh salt.
    await expectOperatorPassword(carolId, "first");
    const [after] = await database(testEnv)
      .select({ password: operatorAccount.password })
      .from(operatorAccount)
      .where(eq(operatorAccount.userId, carolId));
    expect(after?.password).not.toBe(before?.password);
    expect(await sessionIds(carolId)).toEqual([]);
  });

  it("moves the console to the new password", async () => {
    await setOperatorPassword(database(testEnv), encryptionKey(), carolId, "second");

    await expectOperatorPassword(carolId, "second");
  });

  it("keeps the one session it is told to keep", async () => {
    const kept = await insertSession(carolId);
    await insertSession(carolId);

    await setOperatorPassword(database(testEnv), encryptionKey(), carolId, "third", {
      keepSessionId: kept,
    });

    expect(await sessionIds(carolId)).toEqual([kept]);
    await expectOperatorPassword(carolId, "third");
  });

  it("leaves every other operator's password and sessions alone", async () => {
    const [alice] = await database(testEnv)
      .select()
      .from(operator)
      .where(eq(operator.username, "alice"));
    const aliceSession = await insertSession(alice?.id ?? "");

    await setOperatorPassword(database(testEnv), encryptionKey(), carolId, "fourth");

    expect(await sessionIds(alice?.id ?? "")).toEqual([aliceSession]);
    await expectOperatorPassword(alice?.id ?? "", "wonderland");
  });

  it("leaves every Subsonic password alone, a namesake's too", async () => {
    const [namesake] = await database(testEnv)
      .select()
      .from(operator)
      .where(eq(operator.username, "admin"));
    const before = await subsonicUsers();

    await setOperatorPassword(database(testEnv), encryptionKey(), namesake?.id ?? "", "sesame");

    expect(await subsonicUsers()).toEqual(before);
    expect(await subsonicPing(send, BASE, "admin", "sesame")).toBe("ok");
    await expectOperatorPassword(namesake?.id ?? "", "sesame");
  });

  it("rolls the password and the revocation back when a statement alongside fails", async () => {
    const db = database(testEnv);
    await setOperatorPassword(db, encryptionKey(), carolId, "before");
    const kept = await insertSession(carolId);
    await db.insert(property).values({ id: "set-password-test", value: "taken" });

    await expect(
      setOperatorPassword(db, encryptionKey(), carolId, "after", {
        alongside: [db.insert(property).values({ id: "set-password-test", value: "" })],
      }),
    ).rejects.toThrow();

    await expectOperatorPassword(carolId, "before");
    expect(await sessionIds(carolId)).toEqual([kept]);
  });

  it("writes nothing, and answers false, for an operator that does not exist", async () => {
    const before = await database(testEnv).select().from(operatorAccount);

    await expect(
      setOperatorPassword(database(testEnv), encryptionKey(), newRandomId(), "nobody"),
    ).resolves.toBe(false);

    expect(await database(testEnv).select().from(operatorAccount)).toEqual(before);
  });

  it("does not take a Subsonic user's id for an operator's", async () => {
    const admin = await findUserByUsername(database(testEnv), "admin");

    await expect(
      setOperatorPassword(database(testEnv), encryptionKey(), admin?.id ?? "", "taken-over"),
    ).resolves.toBe(false);
    expect(await subsonicPing(send, BASE, "admin", "sesame")).toBe("ok");
  });
});
