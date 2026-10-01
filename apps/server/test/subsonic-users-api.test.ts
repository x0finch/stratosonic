import { subsonicUser } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_JSON_BODY_BYTES } from "../src/api/json-body";
import { database } from "../src/db";
import { MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH } from "../src/users/validation";
import {
  type CookieJar,
  GUEST_ROLE,
  seedConsoleUser,
  signIn,
  subsonicPing,
} from "./console-auth-support";
import {
  expectRefusal,
  type SubsonicUserView,
  snapshot,
  subsonicUsersHarness,
} from "./subsonic-users-support";
import { SEED_TIME, seedUser, testEnv } from "./support";

/**
 * The console's Subsonic-user routes (#82, "API: Subsonic users"; #115):
 * list, create, rename and toggle the admin flag, and set a password. The
 * delete is in subsonic-users-delete.test.ts.
 *
 * The console's owner is `owner`, and `guest` is a console user whose role
 * grants nothing. Every test starts with one Subsonic user, the admin
 * `admin` / `sesame`, stamped `SEED_TIME`, so a write is seen to move
 * `updated_at`.
 */

const ORIGIN = "https://subsonic-users.stratosonic.test";
const harness = subsonicUsersHarness(ORIGIN);
const { call, send } = harness;

let owner: CookieJar;
let guest: CookieJar;
let adminId: string;

beforeAll(async () => {
  await seedConsoleUser("owner", "owner-password");
  await seedConsoleUser("guest", "guest-password", GUEST_ROLE);
  owner = (await signIn(send, ORIGIN, "owner", "owner-password")).jar;
  guest = (await signIn(send, ORIGIN, "guest", "guest-password")).jar;
});

beforeEach(async () => {
  const db = database(testEnv);
  await db.delete(subsonicUser);
  adminId = await seedUser("admin", "sesame", true);
  await db
    .update(subsonicUser)
    .set({ createdAt: SEED_TIME, updatedAt: SEED_TIME })
    .where(eq(subsonicUser.id, adminId));
});

function ping(username: string, password: string) {
  return subsonicPing(send, ORIGIN, username, password);
}

async function userNamed(name: string) {
  const [row] = await database(testEnv)
    .select()
    .from(subsonicUser)
    .where(eq(subsonicUser.userName, name));
  return row;
}

async function listed(): Promise<SubsonicUserView[]> {
  const response = await call(owner, "GET", "/subsonic-users");
  expect(response.status).toBe(200);
  return ((await response.json()) as { users: SubsonicUserView[] }).users;
}

async function create(body: unknown, jar: CookieJar | undefined = owner) {
  return call(jar, "POST", "/subsonic-users", body);
}

/**
 * The refusals every write shares, before the route reads its body or D1:
 * no session, a role without the permission, a request from elsewhere or
 * not in JSON, and a body over the cap.
 */
function itRefusesWhatEveryWriteRefuses(method: string, path: () => string, body: () => unknown) {
  it("refuses a request without a session", async () => {
    await expectRefusal(
      harness,
      () => call(undefined, method, path(), body()),
      401,
      "unauthenticated",
    );
  });

  it("refuses a console user whose role lacks subsonic-users:write", async () => {
    await expectRefusal(harness, () => call(guest, method, path(), body()), 403, "forbidden");
  });

  it("refuses a cross-origin request", async () => {
    await expectRefusal(
      harness,
      () => call(owner, method, path(), body(), { origin: "https://evil.example" }),
      403,
      "forbidden_origin",
    );
  });

  it("refuses a body that is not JSON", async () => {
    await expectRefusal(
      harness,
      () => call(owner, method, path(), body(), { "content-type": "text/plain" }),
      403,
      "forbidden_origin",
    );
  });

  it("refuses a body over the cap", async () => {
    await expectRefusal(
      harness,
      () => call(owner, method, path(), { padding: "x".repeat(MAX_JSON_BODY_BYTES) }),
      413,
      "payload_too_large",
    );
  });

  it("refuses a body that is not a JSON object", async () => {
    await expectRefusal(
      harness,
      () => call(owner, method, path(), [body()]),
      400,
      "invalid_request",
    );
  });
}

describe("GET /api/subsonic-users", () => {
  it("lists every user by name ignoring case, then id, without a password", async () => {
    await seedUser("bob", "builder");
    await seedUser("Alice", "wonderland");
    const lastAccess = new Date(1_760_000_000_000);
    await database(testEnv)
      .update(subsonicUser)
      .set({ lastAccessAt: lastAccess })
      .where(eq(subsonicUser.id, adminId));

    const response = await call(owner, "GET", "/subsonic-users");

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/password/i);
    const { users } = JSON.parse(text) as { users: SubsonicUserView[] };
    expect(users.map((user) => user.username)).toEqual(["admin", "Alice", "bob"]);
    expect(users[0]).toEqual({
      id: adminId,
      username: "admin",
      isAdmin: true,
      createdAt: SEED_TIME.toISOString(),
      updatedAt: SEED_TIME.toISOString(),
      lastAccessAt: lastAccess.toISOString(),
    });
    expect(users[1]).toMatchObject({ isAdmin: false, lastAccessAt: null });
  });

  it("refuses a request without a session", async () => {
    const response = await call(undefined, "GET", "/subsonic-users");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthenticated" });
  });

  it("refuses a console user whose role lacks subsonic-users:read", async () => {
    const response = await call(guest, "GET", "/subsonic-users");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
  });
});

describe("POST /api/subsonic-users", () => {
  it("creates a user who can sign in to Subsonic at once, with p and with t/s", async () => {
    const response = await create({ username: "  carol ", password: "singer" });

    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toMatch(/password/i);
    const { user } = JSON.parse(text) as { user: SubsonicUserView };
    expect(user).toMatchObject({ username: "carol", isAdmin: false, lastAccessAt: null });
    expect(user.createdAt).toBe(user.updatedAt);
    expect(await listed()).toContainEqual(user);
    expect(await ping("carol", "singer")).toBe("ok");
    expect(await ping("Carol", "singer")).toBe("ok");
    expect(await ping("carol", "Singer")).toBe(40);

    // As the bootstrap writes one: `name` is the user name, and the password
    // is ciphertext, never the plaintext.
    const row = await userNamed("carol");
    expect(row).toMatchObject({ id: user.id, name: "carol", email: "", tokenEpoch: 0 });
    expect(row?.password).not.toContain("singer");
  });

  it("creates an admin when asked", async () => {
    const response = await create({ username: "dave", password: "diver", isAdmin: true });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ user: { username: "dave", isAdmin: true } });
  });

  it("keeps a password as typed, spaces and all", async () => {
    await create({ username: "erin", password: " spaced " });

    expect(await ping("erin", " spaced ")).toBe("ok");
    expect(await ping("erin", "spaced")).toBe(40);
  });

  it("takes the longest name and password", async () => {
    const username = "n".repeat(MAX_USERNAME_LENGTH);
    const password = "p".repeat(MAX_PASSWORD_LENGTH);

    expect((await create({ username, password })).status).toBe(201);
    expect(await ping(username, password)).toBe("ok");
  });

  it("refuses a name another user has in another case", async () => {
    await seedUser("alice", "wonderland");

    await expectRefusal(
      harness,
      () => create({ username: "Alice", password: "other" }),
      409,
      "username_taken",
    );
  });

  it.each([
    ["empty", ""],
    ["only whitespace", " \t "],
    ["over the maximum", "n".repeat(MAX_USERNAME_LENGTH + 1)],
  ])("refuses a name that is %s", async (_, username) => {
    await expectRefusal(
      harness,
      () => create({ username, password: "pw" }),
      400,
      "invalid_username",
    );
  });

  it.each([
    ["empty", ""],
    ["1,025 characters", "p".repeat(MAX_PASSWORD_LENGTH + 1)],
  ])("refuses a password that is %s", async (_, password) => {
    await expectRefusal(
      harness,
      () => create({ username: "frank", password }),
      400,
      "invalid_password",
    );
  });

  it.each([
    ["a missing name", { password: "pw" }],
    ["a missing password", { username: "frank" }],
    ["a name that is not a string", { username: 7, password: "pw" }],
    ["an admin flag that is not a boolean", { username: "frank", password: "pw", isAdmin: "yes" }],
  ])("refuses %s as invalid_request", async (_, body) => {
    await expectRefusal(harness, () => create(body), 400, "invalid_request");
  });

  it("refuses a user who is not an admin while no admin exists", async () => {
    await database(testEnv).delete(subsonicUser);

    await expectRefusal(
      harness,
      () => create({ username: "frank", password: "pw" }),
      409,
      "admin_required",
    );
    await expectRefusal(
      harness,
      () => create({ username: "frank", password: "pw", isAdmin: false }),
      409,
      "admin_required",
    );

    const response = await create({ username: "frank", password: "pw", isAdmin: true });
    expect(response.status).toBe(201);
    expect((await create({ username: "grace", password: "pw" })).status).toBe(201);
  });

  itRefusesWhatEveryWriteRefuses(
    "POST",
    () => "/subsonic-users",
    () => ({ username: "frank", password: "pw" }),
  );
});

describe("PATCH /api/subsonic-users/:id", () => {
  function edit(id: string, body: unknown) {
    return call(owner, "PATCH", `/subsonic-users/${id}`, body);
  }

  it("renames a user: the old name stops working and the new one works", async () => {
    const bobId = await seedUser("bob", "builder");

    const response = await edit(bobId, { username: " robert " });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/password/i);
    const { user } = JSON.parse(text) as { user: SubsonicUserView };
    expect(user).toMatchObject({ id: bobId, username: "robert", isAdmin: false });
    expect(await ping("bob", "builder")).toBe(40);
    expect(await ping("robert", "builder")).toBe("ok");
    expect(await userNamed("robert")).toMatchObject({ name: "robert" });
  });

  it("moves updated_at and keeps created_at", async () => {
    const before = Date.now();
    const response = await edit(adminId, { username: "root" });

    const { user } = (await response.json()) as { user: SubsonicUserView };
    expect(user.createdAt).toBe(SEED_TIME.toISOString());
    expect(Date.parse(user.updatedAt)).toBeGreaterThanOrEqual(before);
  });

  it("renames a user to their own name in another case", async () => {
    const response = await edit(adminId, { username: "Admin" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { username: "Admin" } });
    expect(await ping("admin", "sesame")).toBe("ok");
  });

  it("refuses a name another user has in another case", async () => {
    await seedUser("bob", "builder");

    await expectRefusal(harness, () => edit(adminId, { username: "BOB" }), 409, "username_taken");
  });

  it("makes a user an admin, and back", async () => {
    const bobId = await seedUser("bob", "builder");

    expect(await (await edit(bobId, { isAdmin: true })).json()).toMatchObject({
      user: { isAdmin: true },
    });
    expect(await (await edit(bobId, { isAdmin: false })).json()).toMatchObject({
      user: { isAdmin: false },
    });
  });

  it("refuses to demote the only admin", async () => {
    await seedUser("bob", "builder");

    await expectRefusal(harness, () => edit(adminId, { isAdmin: false }), 409, "last_admin");
    await expectRefusal(
      harness,
      () => edit(adminId, { username: "root", isAdmin: false }),
      409,
      "last_admin",
    );
    // Renaming them, or keeping them an admin, is no demotion.
    expect((await edit(adminId, { isAdmin: true })).status).toBe(200);
    expect((await edit(adminId, { username: "root" })).status).toBe(200);
  });

  it("demotes one of two admins, and then not the other", async () => {
    const bobId = await seedUser("bob", "builder", true);

    expect((await edit(bobId, { isAdmin: false })).status).toBe(200);
    await expectRefusal(harness, () => edit(adminId, { isAdmin: false }), 409, "last_admin");
  });

  it("refuses an unknown id", async () => {
    await expectRefusal(harness, () => edit("nobody", { username: "x" }), 404, "not_found");
    await expectRefusal(harness, () => edit("nobody", { isAdmin: false }), 404, "not_found");
  });

  it.each([
    ["empty", ""],
    ["only whitespace", "   "],
  ])("refuses a name that is %s", async (_, username) => {
    await expectRefusal(harness, () => edit(adminId, { username }), 400, "invalid_username");
  });

  it.each([
    ["nothing to change", {}],
    ["a name that is not a string", { username: null }],
    ["an admin flag that is not a boolean", { isAdmin: 1 }],
  ])("refuses %s as invalid_request", async (_, body) => {
    await expectRefusal(harness, () => edit(adminId, body), 400, "invalid_request");
  });

  itRefusesWhatEveryWriteRefuses(
    "PATCH",
    () => `/subsonic-users/${adminId}`,
    () => ({ username: "root" }),
  );
});

describe("PUT /api/subsonic-users/:id/password", () => {
  function setPassword(id: string, body: unknown) {
    return call(owner, "PUT", `/subsonic-users/${id}/password`, body);
  }

  it("sets a password without the old one: the new one works, the old one does not", async () => {
    const bobId = await seedUser("bob", "builder");
    await database(testEnv)
      .update(subsonicUser)
      .set({ updatedAt: SEED_TIME })
      .where(eq(subsonicUser.id, bobId));
    const before = await snapshot();

    const response = await setPassword(bobId, { password: "fixer" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await ping("bob", "fixer")).toBe("ok");
    expect(await ping("bob", "builder")).toBe(40);
    expect(await ping("admin", "sesame")).toBe("ok");

    // Only Bob's password and `updated_at` changed (and `last_access_at`, by
    // the pings); `token_epoch` was not bumped, and nobody else changed.
    const after = await snapshot();
    const bobBefore = before.users.find((user) => user.id === bobId);
    const bobAfter = after.users.find((user) => user.id === bobId);
    expect(bobAfter).toEqual({
      ...bobBefore,
      password: bobAfter?.password,
      updatedAt: bobAfter?.updatedAt,
      lastAccessAt: bobAfter?.lastAccessAt,
    });
    expect(bobAfter?.updatedAt.getTime()).toBeGreaterThan(bobBefore?.updatedAt.getTime() ?? 0);
    expect(bobAfter?.password).not.toBe(bobBefore?.password);
    expect(bobAfter?.tokenEpoch).toBe(0);
    const others = (users: typeof before.users) =>
      users.filter((user) => user.id !== bobId).map((user) => ({ ...user, lastAccessAt: null }));
    expect(others(after.users)).toEqual(others(before.users));
  });

  it("refuses an unknown id", async () => {
    await expectRefusal(harness, () => setPassword("nobody", { password: "x" }), 404, "not_found");
  });

  it.each([
    ["empty", ""],
    ["1,025 characters", "p".repeat(MAX_PASSWORD_LENGTH + 1)],
  ])("refuses a password that is %s", async (_, password) => {
    await expectRefusal(harness, () => setPassword(adminId, { password }), 400, "invalid_password");
  });

  it("refuses a missing password as invalid_request", async () => {
    await expectRefusal(harness, () => setPassword(adminId, {}), 400, "invalid_request");
  });

  itRefusesWhatEveryWriteRefuses(
    "PUT",
    () => `/subsonic-users/${adminId}/password`,
    () => ({ password: "fixer" }),
  );
});
