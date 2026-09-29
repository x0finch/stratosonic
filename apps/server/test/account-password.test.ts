import { account, session, user } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { subsonicToken } from "../src/auth/crypto";
import { MAX_PASSWORD_LENGTH } from "../src/console-auth/credentials";
import { database } from "../src/db";
import type { Env } from "../src/env";
import {
  type CookieJar,
  consoleRequest,
  cost,
  countingD1,
  expectPasswordInvariant,
  type RecordedStatement,
  SESSION_TOKEN_COOKIE,
  shape,
  signIn,
} from "./console-auth-support";
import { type JsonEnvelope, seedUser, testEnv } from "./support";

/**
 * `POST /api/account/password` (#81, #90): a signed-in user changes their own
 * password, which ends their other sessions and moves Subsonic to it.
 */

const ORIGIN = "https://account.stratosonic.test";
const d1 = countingD1(testEnv.DB);
const env: Env = { ...testEnv, DB: d1.binding };
const app = createApp();
const send = (request: Request) => app.request(request, undefined, env);

let bobId: string;

beforeAll(async () => {
  bobId = await seedUser("Bob", "builder");
  await seedUser("Alice", "wonderland", true);
});

function changePassword(jar: CookieJar | undefined, body: unknown, headers = {}) {
  return send(consoleRequest(ORIGIN, "/api/account/password", { body, jar, headers }));
}

async function subsonicStatus(userName: string, password: string): Promise<string> {
  const query = new URLSearchParams({
    u: userName,
    t: await subsonicToken(password, "b0b"),
    s: "b0b",
    v: "1.16.1",
    c: "test",
    f: "json",
  });
  const response = await app.request(`${ORIGIN}/rest/ping?${query}`, undefined, env);

  return ((await response.json()) as JsonEnvelope)["subsonic-response"].status;
}

async function snapshot() {
  const db = database(testEnv);
  return {
    users: await db.select().from(user),
    accounts: await db.select().from(account),
    sessions: await db.select().from(session),
  };
}

async function measured(action: () => unknown): Promise<RecordedStatement[]> {
  d1.reset();
  await action();
  return [...d1.statements];
}

async function sessionIds(userId: string): Promise<string[]> {
  const rows = await database(testEnv)
    .select({ id: session.id })
    .from(session)
    .where(eq(session.userId, userId));
  return rows.map((row) => row.id).sort();
}

/** The id of the session a jar is signed in with. */
async function sessionIdOf(jar: CookieJar): Promise<string | undefined> {
  const token = decodeURIComponent(jar.get(SESSION_TOKEN_COOKIE) ?? "").split(".")[0];
  const [row] = await database(testEnv)
    .select({ id: session.id })
    .from(session)
    .where(eq(session.token, token ?? ""));
  return row?.id;
}

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

describe("POST /api/account/password", () => {
  it("refuses a wrong current password with 400, writing nothing", async () => {
    const { jar } = await signIn(send, ORIGIN, "bob", "builder");

    await expectRefusal(
      () => changePassword(jar, { currentPassword: "Builder", newPassword: "fixer" }),
      400,
      "wrong_password",
    );
    expect(await subsonicStatus("bob", "builder")).toBe("ok");
  });

  it("refuses a request without a session", async () => {
    await expectRefusal(
      () => changePassword(undefined, { currentPassword: "builder", newPassword: "fixer" }),
      401,
      "unauthenticated",
    );
  });

  it("refuses a cross-origin request, however signed in", async () => {
    const { jar } = await signIn(send, ORIGIN, "bob", "builder");

    await expectRefusal(
      () =>
        changePassword(
          jar,
          { currentPassword: "builder", newPassword: "fixer" },
          { origin: "https://evil.example" },
        ),
      403,
      "forbidden_origin",
    );
  });

  it.each([
    ["a missing current password", { newPassword: "fixer" }],
    ["a missing new password", { currentPassword: "builder" }],
    ["a body that is not an object", ["builder", "fixer"]],
  ])("refuses %s as invalid_request", async (_, body) => {
    const { jar } = await signIn(send, ORIGIN, "bob", "builder");

    await expectRefusal(() => changePassword(jar, body), 400, "invalid_request");
  });

  it.each([
    ["empty", ""],
    ["over the maximum", "p".repeat(MAX_PASSWORD_LENGTH + 1)],
  ])("refuses a new password that is %s", async (_, newPassword) => {
    const { jar } = await signIn(send, ORIGIN, "bob", "builder");

    await expectRefusal(
      () => changePassword(jar, { currentPassword: "builder", newPassword }),
      400,
      "invalid_password",
    );
  });

  it("changes the password, keeps this session and ends the others", async () => {
    const { jar: here } = await signIn(send, ORIGIN, "bob", "builder");
    const { jar: elsewhere } = await signIn(send, ORIGIN, "bob", "builder");
    const { jar: alice } = await signIn(send, ORIGIN, "alice", "wonderland");
    const kept = await sessionIdOf(here);

    let response: Response | undefined;
    const statements = await measured(async () => {
      response = await changePassword(here, { currentPassword: "builder", newPassword: "fixer" });
    });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true });
    expect(statements.map(shape)).toEqual([
      "select session", // requireFreshSession, past the cookie cache
      "select user",
      "select user", // the stored password, to check the current one
      "update user",
      "insert account",
      "delete session",
    ]);
    expect(cost(statements).roundTrips).toBe(4);

    expect(await sessionIds(bobId)).toEqual([kept]);
    await expectPasswordInvariant(bobId, "fixer");

    // This session still writes; the other one is refused at once; another
    // user's session is untouched.
    const again = await changePassword(here, { currentPassword: "fixer", newPassword: "builder2" });
    expect(again.status).toBe(200);
    const stale = await changePassword(elsewhere, {
      currentPassword: "builder2",
      newPassword: "x",
    });
    expect(stale.status).toBe(401);
    expect((await send(consoleRequest(ORIGIN, "/api/me", { jar: alice }))).status).toBe(200);
    await expectPasswordInvariant(bobId, "builder2");
  });

  it("moves Subsonic and the console to the new password, and the old one fails", async () => {
    const { jar } = await signIn(send, ORIGIN, "bob", "builder2");

    await changePassword(jar, { currentPassword: "builder2", newPassword: "carpenter" });

    expect(await subsonicStatus("bob", "carpenter")).toBe("ok");
    expect(await subsonicStatus("bob", "builder2")).toBe("failed");
    expect((await signIn(send, ORIGIN, "bob", "carpenter")).response.status).toBe(200);
    expect((await signIn(send, ORIGIN, "bob", "builder2")).response.status).toBe(401);
  });
});
