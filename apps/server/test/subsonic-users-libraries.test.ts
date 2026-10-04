import { DEFAULT_LIBRARY_ID, library, subsonicUser, userLibrary } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { database } from "../src/db";
import { createUser, MAX_USER_LIBRARIES, updateUser } from "../src/users/repository";
import { type CookieJar, cost, seedConsoleUser, signIn } from "./console-auth-support";
import { FakeS3, installFakeS3 } from "./fake-s3";
import { grantsOf, librariesHarness, tables } from "./libraries-support";
import { connectLibrary, resetLibraries } from "./scan-libraries-support";
import { SEED_TIME, seedUser, testEnv } from "./support";

/**
 * Which libraries a Subsonic user may see, from the console (#84, "Per-user
 * access", after Navidrome's `core/library.go: SetUserLibraries` and
 * `persistence/user_repository.go: Put`): `libraryIds` on
 * `/api/subsonic-users`, its refusals, the admin rules, and a change taking
 * effect on the next `/rest` call.
 *
 * Libraries: 1, the bound bucket; 2, connected; 3, connected and being
 * removed.
 */

const ORIGIN = "https://subsonic-users-libraries.stratosonic.test";
const harness = librariesHarness(ORIGIN);
const { call, send } = harness;

const ARCHIVE = 2;
const REMOVING = 3;

let owner: CookieJar;
let adminId: string;
let listenerId: string;
let restoreFetch: () => void;

beforeAll(async () => {
  await seedConsoleUser("owner", "owner-password");
  owner = (await signIn(send, ORIGIN, "owner", "owner-password")).jar;
});

beforeEach(async () => {
  await resetLibraries();
  const db = database(testEnv);
  await db.delete(subsonicUser);
  const fake = new FakeS3();
  const spy = installFakeS3(fake);
  restoreFetch = () => spy.mockRestore();
  await connectLibrary(fake, ARCHIVE);
  await db.insert(library).values({
    id: REMOVING,
    name: "Leaving",
    path: "s3://00000000000000000000000000000003.r2.cloudflarestorage.com/leaving",
    kind: "s3",
    defaultNewUsers: true,
    state: "removing",
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
  });
  adminId = await seedUser("admin", "sesame", true);
  listenerId = await seedUser("listener", "pw");
});

afterEach(() => {
  restoreFetch();
});

/** What `getMusicFolders` answers a Subsonic user, by id. */
async function musicFolders(username: string, password: string): Promise<number[]> {
  const query = new URLSearchParams({
    u: username,
    p: password,
    v: "1.16.1",
    c: "test",
    f: "json",
  });
  const response = await send(new Request(`${ORIGIN}/rest/getMusicFolders?${query}`));
  const body = (await response.json()) as {
    "subsonic-response": { musicFolders?: { musicFolder?: { id: number }[] } };
  };
  return (body["subsonic-response"].musicFolders?.musicFolder ?? []).map((folder) => folder.id);
}

/** That a request is refused with this error and changes no row. */
async function expectRefused(
  request: () => Promise<Response>,
  status: number,
  error: string,
): Promise<void> {
  const before = await tables();
  harness.d1.reset();
  const response = await request();
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
  expect(cost(harness.d1.statements).rowsWritten).toBe(0);
  expect(await tables()).toEqual(before);
}

describe("GET /api/subsonic-users", () => {
  it("lists each user's libraries, and the libraries a user may be given", async () => {
    const response = await call(owner, "GET", "/subsonic-users");
    const body = (await response.json()) as {
      users: { username: string; libraryIds: number[] }[];
      libraries: { id: number; name: string }[];
    };

    expect(body.libraries).toEqual([
      { id: 1, name: "Music Library" },
      { id: ARCHIVE, name: "Archive" },
    ]);
    expect(body.users.map((user) => [user.username, user.libraryIds])).toEqual([
      ["admin", [1, ARCHIVE]],
      ["listener", [1]],
    ]);
  });
});

describe("POST /api/subsonic-users with libraryIds", () => {
  it("gives a new non-admin the libraries listed, instead of the defaults", async () => {
    const response = await call(owner, "POST", "/subsonic-users", {
      username: "two",
      password: "pw",
      libraryIds: [ARCHIVE, ARCHIVE],
    });

    expect(response.status).toBe(201);
    const { user } = (await response.json()) as { user: { id: string; libraryIds: number[] } };
    expect(user.libraryIds).toEqual([ARCHIVE]);
    expect(await grantsOf(user.id)).toEqual([ARCHIVE]);
    expect(await musicFolders("two", "pw")).toEqual([ARCHIVE]);
  });

  it("gives the defaults without a list, never a library being removed", async () => {
    const response = await call(owner, "POST", "/subsonic-users", {
      username: "d",
      password: "pw",
    });
    const { user } = (await response.json()) as { user: { id: string; libraryIds: number[] } };
    expect(user.libraryIds).toEqual([1]);
    expect(await grantsOf(user.id)).toEqual([1]);
  });

  it("gives a new admin every active library", async () => {
    const response = await call(owner, "POST", "/subsonic-users", {
      username: "boss",
      password: "pw",
      isAdmin: true,
    });
    const { user } = (await response.json()) as { user: { id: string; libraryIds: number[] } };
    expect(user.libraryIds).toEqual([1, ARCHIVE]);
    expect(await grantsOf(user.id)).toEqual([1, ARCHIVE]);
  });

  it.each([
    ["an empty list", { libraryIds: [] }, "libraries_required"],
    ["an unknown library", { libraryIds: [1, 999] }, "invalid_library"],
    ["a library being removed", { libraryIds: [REMOVING] }, "invalid_library"],
    ["a list for an admin", { isAdmin: true, libraryIds: [1] }, "admin_has_all_libraries"],
    ["a list that is not one", { libraryIds: 1 }, "invalid_request"],
    ["an id that is not a positive integer", { libraryIds: [1.5] }, "invalid_request"],
    ["an id that is a string", { libraryIds: ["1"] }, "invalid_request"],
    [
      "a list too long to bind",
      { libraryIds: Array.from({ length: MAX_USER_LIBRARIES + 1 }, (_, index) => index + 1) },
      "invalid_request",
    ],
  ])("refuses %s, and writes nothing", async (_, extra, error) => {
    await expectRefused(
      () => call(owner, "POST", "/subsonic-users", { username: "x", password: "pw", ...extra }),
      400,
      error,
    );
  });

  it("still says admin_required for a list when there is no admin", async () => {
    await database(testEnv).delete(subsonicUser);
    expect(
      await createUser(database(testEnv), {
        userName: "first",
        password: "c",
        isAdmin: false,
        libraryIds: [1],
      }),
    ).toBe("admin_required");
  });
});

describe("PATCH /api/subsonic-users/:id with libraryIds", () => {
  it("replaces a user's libraries in one batch, effective on the next /rest call", async () => {
    expect(await musicFolders("listener", "pw")).toEqual([1]);

    harness.d1.reset();
    const response = await call(owner, "PATCH", `/subsonic-users/${listenerId}`, {
      libraryIds: [ARCHIVE],
    });

    expect(response.status).toBe(200);
    const { user } = (await response.json()) as { user: { libraryIds: number[] } };
    expect(user.libraryIds).toEqual([ARCHIVE]);
    expect(await grantsOf(listenerId)).toEqual([ARCHIVE]);
    expect(await musicFolders("listener", "pw")).toEqual([ARCHIVE]);

    const both = await call(owner, "PATCH", `/subsonic-users/${listenerId}`, {
      libraryIds: [1, ARCHIVE],
      username: "listener",
    });
    expect(((await both.json()) as { user: { libraryIds: number[] } }).user.libraryIds).toEqual([
      1,
      ARCHIVE,
    ]);
    expect(await musicFolders("listener", "pw")).toEqual([1, ARCHIVE]);
  });

  it("refuses a list for an admin, and writes nothing", async () => {
    await expectRefused(
      () => call(owner, "PATCH", `/subsonic-users/${adminId}`, { libraryIds: [1] }),
      400,
      "admin_has_all_libraries",
    );
    await expectRefused(
      () => call(owner, "PATCH", `/subsonic-users/${adminId}`, { isAdmin: true, libraryIds: [1] }),
      400,
      "admin_has_all_libraries",
    );
  });

  it.each([
    ["an empty list", [], "libraries_required"],
    ["an unknown library", [ARCHIVE, 999], "invalid_library"],
    ["a library being removed", [REMOVING], "invalid_library"],
  ])("refuses %s, and writes nothing", async (_, libraryIds, error) => {
    await expectRefused(
      () =>
        call(owner, "PATCH", `/subsonic-users/${listenerId}`, { username: "renamed", libraryIds }),
      400,
      error,
    );
  });

  it("answers not_found for an unknown user", async () => {
    await expectRefused(
      () => call(owner, "PATCH", "/subsonic-users/nobody", { libraryIds: [1] }),
      404,
      "not_found",
    );
  });

  it("demotes an admin and sets their list together, unless they are the last admin", async () => {
    const second = await seedUser("second", "pw", true);
    const response = await call(owner, "PATCH", `/subsonic-users/${second}`, {
      isAdmin: false,
      libraryIds: [ARCHIVE],
    });
    expect(response.status).toBe(200);
    expect(await grantsOf(second)).toEqual([ARCHIVE]);

    await expectRefused(
      () => call(owner, "PATCH", `/subsonic-users/${adminId}`, { isAdmin: false, libraryIds: [1] }),
      409,
      "last_admin",
    );
  });

  it("gives every active library on a promotion, and keeps the rows on a demotion", async () => {
    const promoted = await call(owner, "PATCH", `/subsonic-users/${listenerId}`, { isAdmin: true });
    expect(((await promoted.json()) as { user: { libraryIds: number[] } }).user.libraryIds).toEqual(
      [1, ARCHIVE],
    );
    // Never the library being removed.
    expect(await grantsOf(listenerId)).toEqual([1, ARCHIVE]);

    const demoted = await call(owner, "PATCH", `/subsonic-users/${listenerId}`, { isAdmin: false });
    expect(((await demoted.json()) as { user: { libraryIds: number[] } }).user.libraryIds).toEqual([
      1,
      ARCHIVE,
    ]);
    expect(await grantsOf(listenerId)).toEqual([1, ARCHIVE]);
    expect(await musicFolders("listener", "pw")).toEqual([1, ARCHIVE]);
  });
});

describe("the writes beneath", () => {
  it("never rewrites the rows of an update that was refused", async () => {
    // The listing is guarded by the update having been written: a refusal by
    // the last-admin guard leaves the admin's rows alone.
    await database(testEnv).delete(userLibrary).where(eq(userLibrary.libraryId, ARCHIVE));
    expect(
      await updateUser(database(testEnv), adminId, { isAdmin: false, libraryIds: [ARCHIVE] }),
    ).toBeNull();
    expect(await grantsOf(adminId)).toEqual([DEFAULT_LIBRARY_ID]);
  });
});
