import {
  consoleAccount,
  consoleSession,
  consoleUser,
  property,
  rateLimit,
  subsonicUser,
} from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { PERMISSIONS } from "../src/console-auth/permissions";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { runInitialSetup } from "../src/setup/initial-setup";
import { setupTokenDigest } from "../src/setup/setup-token";
import { MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH } from "../src/users/validation";
import {
  consoleRequest,
  cost,
  countingD1,
  expectConsolePassword,
  type RecordedStatement,
  seedConsoleUser,
  shape,
  signIn,
  subsonicPing,
} from "./console-auth-support";
import { seedUser, testEnv } from "./support";

/**
 * First-run setup with the setup token (#81, #90, #99, #105), through the
 * Worker's app over a D1 binding that counts every statement. It creates the
 * owner, a console user, the console's own kind of account, and never a
 * Subsonic user. The token resets no password: `/api/setup/reset` is gone.
 *
 * This file owns its database, and every test starts from an empty one: the
 * app is called directly rather than through the Worker's `fetch`, which would
 * run the first-run bootstrap and create the Subsonic `admin` from the test
 * bindings.
 */

const ORIGIN = "https://setup.stratosonic.test";
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_TOKEN = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const d1 = countingD1(testEnv.DB);
const app = createApp();

/** The Worker's environment with a `SETUP_TOKEN`, or none, over the counting binding. */
function envWith(token: string | null = TOKEN): Env {
  return { ...testEnv, DB: d1.binding, SETUP_TOKEN: token ?? undefined };
}

function send(request: Request, env = envWith()) {
  return app.request(request, undefined, env);
}

async function state(env = envWith()): Promise<unknown> {
  return (await send(consoleRequest(ORIGIN, "/api/setup"), env)).json();
}

interface Form {
  token?: unknown;
  username?: unknown;
  password?: unknown;
}

function setup(body: Form, env = envWith()) {
  return send(consoleRequest(ORIGIN, "/api/setup", { body }), env);
}

/** What a Subsonic `ping` answers with these credentials: "ok", or the error code. */
function subsonicStatus(username: string, password: string) {
  return subsonicPing(send, ORIGIN, username, password);
}

/** Every row setup could touch. */
async function snapshot() {
  const db = database(testEnv);
  return {
    subsonicUsers: await db.select().from(subsonicUser),
    consoleUsers: await db.select().from(consoleUser),
    accounts: await db.select().from(consoleAccount),
    sessions: await db.select().from(consoleSession),
    properties: await db.select().from(property),
  };
}

/** Runs `action`, and answers the statements it sent to D1. */
async function measured(action: () => unknown): Promise<RecordedStatement[]> {
  d1.reset();
  await action();
  return [...d1.statements];
}

/**
 * Runs a request that must be refused and checks that it wrote nothing: no
 * row D1 counts as written, and every table as it was.
 */
async function expectRefusal(
  request: () => Response | Promise<Response>,
  status: number,
  error: string,
): Promise<void> {
  const before = await snapshot();
  let response: Response | undefined;
  const statements = await measured(async () => {
    response = await request();
  });

  expect(response?.status).toBe(status);
  expect(await response?.json()).toEqual({ error });
  expect(cost(statements).rowsWritten).toBe(0);
  expect(await snapshot()).toEqual(before);
}

async function spentRows() {
  const rows = await database(testEnv).select().from(property);
  return rows.filter((row) => row.id.startsWith("SetupTokenSpent:"));
}

async function sessionsOf(userId: string) {
  const rows = await database(testEnv).select().from(consoleSession);
  return rows.filter((row) => row.userId === userId);
}

beforeEach(async () => {
  const db = database(testEnv);
  await db.delete(consoleSession);
  await db.delete(consoleAccount);
  await db.delete(consoleUser);
  await db.delete(subsonicUser);
  await db.delete(property);
  await db.delete(rateLimit);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/setup", () => {
  it("is closed without a token, and asks D1 nothing", async () => {
    const statements = await measured(async () => {
      expect(await state(envWith(null))).toEqual({ state: "closed" });
      expect(await state(envWith(""))).toEqual({ state: "closed" });
    });

    expect(statements).toEqual([]);
  });

  it("is closed with a token under 32 characters, which it reports once per isolate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const short = TOKEN.slice(0, 31);

    const statements = await measured(async () => {
      expect(await state(envWith(short))).toEqual({ state: "closed" });
      expect(await state(envWith(short))).toEqual({ state: "closed" });
    });

    expect(statements).toEqual([]);
    const reports = warn.mock.calls.filter((call) => String(call[0]).includes("SETUP_TOKEN"));
    expect(reports).toHaveLength(1);
  });

  it("needs setup with a token of 32 characters or more and no console user, in one read", async () => {
    let answer: unknown;
    const statements = await measured(async () => {
      answer = await state(envWith(TOKEN.slice(0, 32)));
    });

    expect(answer).toEqual({ state: "needs-setup" });
    expect(statements).toHaveLength(1);
    expect(cost(statements).rowsWritten).toBe(0);
  });

  it("is closed once a console user exists, even with an unspent token", async () => {
    await seedConsoleUser("owner", "old");

    expect(await state()).toEqual({ state: "closed" });
  });

  it("still needs setup while only Subsonic users exist", async () => {
    await seedUser("admin", "sesame", true);

    expect(await state()).toEqual({ state: "needs-setup" });
  });

  it("is closed once the token has been used, and for a new value too while the owner exists", async () => {
    expect((await setup({ token: TOKEN, username: "owner", password: "pw" })).status).toBe(201);

    expect(await state()).toEqual({ state: "closed" });
    expect(await state(envWith(OTHER_TOKEN))).toEqual({ state: "closed" });
  });

  it("is closed for a spent token even when no console user is left", async () => {
    expect((await setup({ token: TOKEN, username: "owner", password: "pw" })).status).toBe(201);
    await database(testEnv).delete(consoleUser);

    expect(await state()).toEqual({ state: "closed" });
    await expectRefusal(
      () => setup({ token: TOKEN, username: "owner", password: "pw" }),
      403,
      "invalid_token",
    );
  });
});

describe("POST /api/setup", () => {
  it("creates the owner, spends the token, and costs one read and one batch", async () => {
    let response: Response | undefined;
    const statements = await measured(async () => {
      response = await setup({ token: TOKEN, username: "Owner", password: "correct horse" });
    });

    expect(response?.status).toBe(201);
    const created = (await response?.json()) as { id: string };
    expect(created).toEqual({
      id: expect.any(String),
      username: "Owner",
      role: "owner",
      permissions: [...PERMISSIONS],
    });
    expect(statements.map(shape)).toEqual([
      "select user", // whether any console user exists and whether the token is spent
      "insert user",
      "insert account",
      "insert property", // the spent token
    ]);
    expect(cost(statements).roundTrips).toBe(2);
    // D1 counts each index entry as a row written: the console user and its
    // four indexes (the owner's among them), the account and its three, and
    // the spent token and its key.
    expect(cost(statements).rowsWritten).toBe(11);

    const [owner] = await database(testEnv).select().from(consoleUser);
    expect(owner).toMatchObject({
      id: created.id,
      displayUsername: "Owner",
      username: "owner",
      role: "owner",
    });
    await expectConsolePassword(created.id, "correct horse");
    expect(await database(testEnv).select().from(subsonicUser)).toEqual([]);
    expect(await spentRows()).toEqual([
      { id: `SetupTokenSpent:${await setupTokenDigest(TOKEN)}`, value: expect.any(String) },
    ]);
  });

  it("leaves an owner who can sign in to the console, and not to Subsonic", async () => {
    const created = await setup({ token: TOKEN, username: "Owner", password: "correct horse" });
    const { id } = (await created.json()) as { id: string };

    const { response, jar } = await signIn(send, ORIGIN, "owner", "correct horse");
    expect(response.status).toBe(200);
    const me = await send(consoleRequest(ORIGIN, "/api/me", { jar }));
    expect(await me.json()).toEqual({
      id,
      username: "Owner",
      role: "owner",
      permissions: [...PERMISSIONS],
    });
    expect(await subsonicStatus("owner", "correct horse")).toBe(40);
  });

  it("drops the whitespace around the name", async () => {
    const response = await setup({ token: TOKEN, username: "  Owner \t", password: "pw" });

    expect(await response.json()).toMatchObject({ username: "Owner" });
  });

  it("refuses without a token configured", async () => {
    await expectRefusal(
      () => setup({ token: "", username: "owner", password: "pw" }, envWith(null)),
      403,
      "invalid_token",
    );
  });

  it("refuses when the configured token is under 32 characters, even if it is given", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const short = TOKEN.slice(0, 31);

    await expectRefusal(
      () => setup({ token: short, username: "owner", password: "pw" }, envWith(short)),
      403,
      "invalid_token",
    );
  });

  it.each([
    ["another token", OTHER_TOKEN],
    ["a prefix of the token", TOKEN.slice(0, 32)],
    ["the token and more", `${TOKEN}x`],
    ["an empty token", ""],
  ])("refuses %s", async (_, token) => {
    await expectRefusal(
      () => setup({ token, username: "owner", password: "pw" }),
      403,
      "invalid_token",
    );
  });

  it("refuses a spent token, even with a new name", async () => {
    await setup({ token: TOKEN, username: "owner", password: "pw" });

    await expectRefusal(
      () => setup({ token: TOKEN, username: "someone-else", password: "pw" }),
      403,
      "invalid_token",
    );
  });

  it("refuses while a console user exists, with an unspent token", async () => {
    await seedConsoleUser("first", "pw");

    await expectRefusal(
      () => setup({ token: TOKEN, username: "owner", password: "pw" }),
      409,
      "already_set_up",
    );
  });

  it("creates the owner while Subsonic users exist, and leaves them as they were", async () => {
    await seedUser("owner", "subsonic password", true);
    const before = await database(testEnv).select().from(subsonicUser);

    const response = await setup({ token: TOKEN, username: "owner", password: "console password" });

    expect(response.status).toBe(201);
    expect(await database(testEnv).select().from(subsonicUser)).toEqual(before);
    expect(await subsonicStatus("owner", "subsonic password")).toBe("ok");
    expect(await subsonicStatus("owner", "console password")).toBe(40);
    expect((await signIn(send, ORIGIN, "owner", "subsonic password")).response.status).toBe(401);
    expect((await signIn(send, ORIGIN, "owner", "console password")).response.status).toBe(200);
  });

  it.each([
    ["a body that is not JSON", () => "{"],
    ["a missing token", () => ({ username: "owner", password: "pw" })],
    ["a missing name", () => ({ token: TOKEN, password: "pw" })],
    ["a password that is not a string", () => ({ token: TOKEN, username: "owner", password: 1 })],
  ])("refuses %s as invalid_request", async (_, body) => {
    await expectRefusal(
      () =>
        send(
          new Request(`${ORIGIN}/api/setup`, {
            method: "POST",
            headers: { origin: ORIGIN, "content-type": "application/json" },
            body: typeof body() === "string" ? (body() as string) : JSON.stringify(body()),
          }),
        ),
      400,
      "invalid_request",
    );
  });

  it.each([
    ["an empty name", ""],
    ["a name of whitespace", "   "],
    ["a name over 255 characters", "n".repeat(MAX_USERNAME_LENGTH + 1)],
  ])("refuses %s", async (_, username) => {
    await expectRefusal(
      () => setup({ token: TOKEN, username, password: "pw" }),
      400,
      "invalid_username",
    );
  });

  it.each([
    ["an empty password", ""],
    ["a password over the maximum", "p".repeat(MAX_PASSWORD_LENGTH + 1)],
  ])("refuses %s", async (_, password) => {
    await expectRefusal(
      () => setup({ token: TOKEN, username: "owner", password }),
      400,
      "invalid_password",
    );
  });

  it("accepts a name of 255 characters and a password of the maximum length", async () => {
    const response = await setup({
      token: TOKEN,
      username: "n".repeat(MAX_USERNAME_LENGTH),
      password: "p".repeat(MAX_PASSWORD_LENGTH),
    });

    expect(response.status).toBe(201);
  });

  it("checks the token before anything else it is sent", async () => {
    await expectRefusal(
      () => setup({ token: OTHER_TOKEN, username: "", password: "" }),
      403,
      "invalid_token",
    );
  });

  it("refuses a cross-origin request before reading anything", async () => {
    await expectRefusal(
      () =>
        send(
          consoleRequest(ORIGIN, "/api/setup", {
            body: { token: TOKEN, username: "owner", password: "pw" },
            headers: { origin: "https://evil.example" },
          }),
        ),
      403,
      "forbidden_origin",
    );
  });

  it("makes exactly one owner when two setups race, whatever names they ask for", async () => {
    let responses: Response[] = [];
    const statements = await measured(async () => {
      responses = await Promise.all([
        setup({ token: TOKEN, username: "first", password: "one" }),
        setup({ token: TOKEN, username: "second", password: "two" }),
      ]);
    });

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    // Both read an empty table and sent their batch: the guard inside the
    // insert, not the read before it, is what stopped the second.
    expect(statements.map(shape).filter((s) => s === "insert user")).toHaveLength(2);
    const consoleUsers = await database(testEnv).select().from(consoleUser);
    expect(consoleUsers).toHaveLength(1);
    expect(await database(testEnv).select().from(consoleAccount)).toHaveLength(1);
    expect(await spentRows()).toHaveLength(1);
    const [winner] = consoleUsers;
    await expectConsolePassword(
      winner?.id ?? "",
      winner?.displayUsername === "first" ? "one" : "two",
    );
  });

  it("rolls the owner back when the token is spent between its check and its batch", async () => {
    const batch = d1.binding.batch.bind(d1.binding);
    vi.spyOn(d1.binding, "batch").mockImplementationOnce(async (statements) => {
      await database(testEnv)
        .insert(property)
        .values({ id: `SetupTokenSpent:${await setupTokenDigest(TOKEN)}`, value: "raced" });
      return batch(statements);
    });

    const response = await setup({ token: TOKEN, username: "owner", password: "pw" });

    // The console user was inserted, then the spent token's insert hit the
    // key and took it back out with the whole batch.
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "invalid_token" });
    expect(await database(testEnv).select().from(consoleUser)).toEqual([]);
    expect(await database(testEnv).select().from(consoleAccount)).toEqual([]);
    expect(await spentRows()).toEqual([expect.objectContaining({ value: "raced" })]);
  });

  it("neither races nor is raced by the INITIAL_* bootstrap, which makes a Subsonic user", async () => {
    const [response] = await Promise.all([
      setup({ token: TOKEN, username: "admin", password: "pw" }),
      runInitialSetup(envWith()),
    ]);

    expect(response.status).toBe(201);
    expect(await database(testEnv).select().from(consoleUser)).toHaveLength(1);
    expect(await database(testEnv).select().from(subsonicUser)).toMatchObject([
      { userName: "admin", isAdmin: true },
    ]);
    expect(await spentRows()).toHaveLength(1);
    expect(await subsonicStatus("admin", "sesame")).toBe("ok");
    expect(await subsonicStatus("admin", "pw")).toBe(40);
  });
});

describe("the setup token's other uses", () => {
  it("resets no password: /api/setup/reset is the API's JSON 404, and writes nothing", async () => {
    const ownerId = await seedConsoleUser("owner", "forgotten");

    await expectRefusal(
      () =>
        send(
          consoleRequest(ORIGIN, "/api/setup/reset", {
            body: { token: TOKEN, username: "owner", password: "remembered" },
          }),
        ),
      404,
      "not_found",
    );
    await expectConsolePassword(ownerId, "forgotten");
  });
});

/**
 * The last resort for a lost owner password (apps/server/README.md): the
 * owner's row is deleted by hand, its sessions and credential account go with
 * it, and the server is set up again with a new token.
 */
describe("setting up again after the owner is deleted", () => {
  /** The statement the README gives, as `wrangler d1 execute` runs it. */
  async function deleteOwner(): Promise<void> {
    await testEnv.DB.prepare("DELETE FROM user WHERE role = 'owner'").run();
  }

  async function accountsOf(userId: string) {
    return database(testEnv).select().from(consoleAccount).where(eq(consoleAccount.userId, userId));
  }

  it("takes the owner's sessions and credential account with it, and no Subsonic user", async () => {
    const created = await setup({ token: TOKEN, username: "Owner", password: "forgotten" });
    const { id: ownerId } = (await created.json()) as { id: string };
    const { jar } = await signIn(send, ORIGIN, "owner", "forgotten");
    await signIn(send, ORIGIN, "owner", "forgotten");
    await seedUser("listener", "music");
    const subsonicUsers = await database(testEnv).select().from(subsonicUser);
    expect(await sessionsOf(ownerId)).toHaveLength(2);
    expect(await accountsOf(ownerId)).toHaveLength(1);

    await deleteOwner();

    expect(await database(testEnv).select().from(consoleUser)).toEqual([]);
    expect(await sessionsOf(ownerId)).toEqual([]);
    expect(await accountsOf(ownerId)).toEqual([]);
    // A write checks the session against D1, so the old cookie is refused at
    // once; reads may pass on the cookie cache for up to its five minutes.
    const write = await send(
      consoleRequest(ORIGIN, "/api/account/password", {
        body: { currentPassword: "forgotten", newPassword: "x" },
        jar,
      }),
    );
    expect(write.status).toBe(401);
    expect(await database(testEnv).select().from(subsonicUser)).toEqual(subsonicUsers);
    expect(await subsonicStatus("listener", "music")).toBe("ok");
  });

  it("opens setup to a new token, and still refuses the spent one", async () => {
    await setup({ token: TOKEN, username: "owner", password: "forgotten" });
    await deleteOwner();

    expect(await state()).toEqual({ state: "closed" });
    await expectRefusal(
      () => setup({ token: TOKEN, username: "owner", password: "stolen" }),
      403,
      "invalid_token",
    );

    const fresh = envWith(OTHER_TOKEN);
    expect(await state(fresh)).toEqual({ state: "needs-setup" });
    const response = await setup(
      { token: OTHER_TOKEN, username: "owner", password: "remembered" },
      fresh,
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ username: "owner", role: "owner" });
    expect((await signIn(send, ORIGIN, "owner", "remembered")).response.status).toBe(200);
    expect((await signIn(send, ORIGIN, "owner", "forgotten")).response.status).toBe(401);
    expect(await spentRows()).toHaveLength(2);
    expect(await state(fresh)).toEqual({ state: "closed" });
  });
});
