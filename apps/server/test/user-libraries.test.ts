import { subsonicUser, userLibrary } from "@stratosonic/db";
import { asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { runInitialSetup } from "../src/setup/initial-setup";
import { createUser, isUserNameConflict, updateUser } from "../src/users/repository";
import { testEnv } from "./support";

/**
 * Which libraries a Subsonic user is given when created or promoted (#84,
 * "Per-user access"), after Navidrome's user repository `Put`: an admin gets
 * every library, a new non-admin the `default_new_users` ones, and a demoted
 * admin keeps what they had. These writes ship before anything reads them, so
 * every user has rows by the time access is enforced.
 *
 * This file owns its database: the bootstrap admin is the first user, so no
 * request may run the first-run setup before `beforeAll` does.
 */

const db = database(testEnv);

/** Library 1 from the migration, plus one that is not a default and one that is. */
const ALL = [1, 2, 3];
const DEFAULTS = [1, 3];

async function librariesOf(userId: string): Promise<number[]> {
  const rows = await db
    .select({ libraryId: userLibrary.libraryId })
    .from(userLibrary)
    .where(eq(userLibrary.userId, userId))
    .orderBy(asc(userLibrary.libraryId));

  return rows.map((row) => row.libraryId);
}

let bootstrapAdminId = "";

beforeAll(async () => {
  await testEnv.DB.prepare(
    `INSERT INTO library (id, name, path, kind, default_new_users, created_at, updated_at)
     VALUES (2, 'Archive', 's3://acct.r2.cloudflarestorage.com/archive', 's3', 0, 0, 0),
            (3, 'Shared', 's3://acct.r2.cloudflarestorage.com/shared', 's3', 1, 0, 0)`,
  ).run();

  await runInitialSetup(testEnv);
  const [admin] = await db.select().from(subsonicUser);
  bootstrapAdminId = admin?.id ?? "";
});

describe("the libraries a user is given", () => {
  it("gives the bootstrap admin every library", async () => {
    expect(bootstrapAdminId).not.toBe("");
    expect(await librariesOf(bootstrapAdminId)).toEqual(ALL);
  });

  it("gives a new admin every library", async () => {
    const created = await createUser(db, {
      userName: "second-admin",
      password: "c",
      isAdmin: true,
    });
    if (created === "admin_required") throw new Error("refused");

    expect(await librariesOf(created.id)).toEqual(ALL);
  });

  it("gives a new non-admin the default libraries only", async () => {
    const created = await createUser(db, { userName: "listener", password: "c", isAdmin: false });
    if (created === "admin_required") throw new Error("refused");

    expect(await librariesOf(created.id)).toEqual(DEFAULTS);
  });

  it("grants nothing when the create itself is refused", async () => {
    const before = await db.select().from(userLibrary);

    const conflict = await createUser(db, { userName: "LISTENER", password: "c", isAdmin: true })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(isUserNameConflict(conflict)).toBe(true);
    expect(await db.select().from(userLibrary)).toEqual(before);
  });

  it("gives every library to a user made an admin, and keeps them when unmade", async () => {
    const created = await createUser(db, { userName: "promoted", password: "c", isAdmin: false });
    if (created === "admin_required") throw new Error("refused");
    expect(await librariesOf(created.id)).toEqual(DEFAULTS);

    expect((await updateUser(db, created.id, { isAdmin: true }))?.isAdmin).toBe(true);
    expect(await librariesOf(created.id)).toEqual(ALL);

    expect((await updateUser(db, created.id, { isAdmin: false }))?.isAdmin).toBe(false);
    expect(await librariesOf(created.id)).toEqual(ALL);
  });

  it("changes no libraries on a rename, and grants nothing to a user that does not exist", async () => {
    const created = await createUser(db, { userName: "renamed", password: "c", isAdmin: false });
    if (created === "admin_required") throw new Error("refused");

    await updateUser(db, created.id, { userName: "renamed-again" });
    expect(await librariesOf(created.id)).toEqual(DEFAULTS);

    expect(await updateUser(db, "no-such-user", { isAdmin: true })).toBeNull();
    expect(await librariesOf("no-such-user")).toEqual([]);
  });
});
