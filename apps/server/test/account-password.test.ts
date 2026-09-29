import { account, rateLimit, session, user } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_JSON_BODY_BYTES } from "../src/api/json-body";
import { createApp } from "../src/app";
import { subsonicToken } from "../src/auth/crypto";
import { MAX_PASSWORD_LENGTH, setPassword } from "../src/console-auth/credentials";
import {
  MAX_FAILED_PASSWORD_ATTEMPTS,
  PASSWORD_ATTEMPT_KEY_PREFIX,
  PASSWORD_ATTEMPT_WINDOW_MS,
} from "../src/console-auth/password-attempts";
import {
  LONGEST_RATE_LIMIT_WINDOW_MS,
  pruneExpiredAuthRows,
  RATE_LIMIT_RETENTION_MS,
} from "../src/console-auth/prune";
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
import { encryptionKey, type JsonEnvelope, seedUser, testEnv } from "./support";

/**
 * `POST /api/account/password` (#81, #90): a signed-in user changes their own
 * password, which ends their other sessions and moves Subsonic to it.
 *
 * Every test starts with Bob's password `builder`, no session of his and no
 * failed attempts counted.
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

beforeEach(async () => {
  // Also ends every session of Bob's.
  await setPassword(database(testEnv), encryptionKey(), bobId, "builder");
  await database(testEnv).delete(rateLimit);
});

afterEach(() => {
  vi.useRealTimers();
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
    rateLimits: await db.select().from(rateLimit),
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

async function attemptRows() {
  const rows = await database(testEnv).select().from(rateLimit);
  return rows.filter((row) => row.key === `${PASSWORD_ATTEMPT_KEY_PREFIX}${bobId}`);
}

describe("POST /api/account/password", () => {
  it("refuses a wrong current password with 400, writing only the failed attempt", async () => {
    const { jar } = await signIn(send, ORIGIN, "bob", "builder");
    const before = await snapshot();

    let response: Response | undefined;
    const statements = await measured(async () => {
      response = await changePassword(jar, { currentPassword: "Builder", newPassword: "fixer" });
    });

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: "wrong_password" });
    expect(statements.map(shape).at(-1)).toBe("insert rate_limit");
    const after = await snapshot();
    expect({ ...after, rateLimits: [] }).toEqual({ ...before, rateLimits: [] });
    expect(await attemptRows()).toMatchObject([{ count: 1 }]);
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
    const rateLimitsBefore = (await snapshot()).rateLimits;

    let response: Response | undefined;
    const statements = await measured(async () => {
      response = await changePassword(here, { currentPassword: "builder", newPassword: "fixer" });
    });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true });
    expect(statements.map(shape)).toEqual([
      "select session", // requireFreshSession, past the cookie cache
      "select user",
      // The stored password, with the recent failures from a subquery on
      // rate_limit, which is the table the shape names first.
      "select rate_limit",
      "update user",
      "insert account",
      "delete session",
    ]);
    expect(cost(statements).roundTrips).toBe(4);
    // The user row and the account, and the one other session; nothing in
    // rate_limit.
    expect(cost(statements).rowsWritten).toBe(2 + 1);
    expect((await snapshot()).rateLimits).toEqual(rateLimitsBefore);

    expect(await sessionIds(bobId)).toEqual([kept]);
    await expectPasswordInvariant(bobId, "fixer");

    // This session still writes; the other one is refused at once; another
    // user's session is untouched.
    const again = await changePassword(here, { currentPassword: "fixer", newPassword: "fixer2" });
    expect(again.status).toBe(200);
    const stale = await changePassword(elsewhere, { currentPassword: "fixer2", newPassword: "x" });
    expect(stale.status).toBe(401);
    expect((await send(consoleRequest(ORIGIN, "/api/me", { jar: alice }))).status).toBe(200);
    await expectPasswordInvariant(bobId, "fixer2");
  });

  it("moves Subsonic and the console to the new password, and the old one fails", async () => {
    const { jar } = await signIn(send, ORIGIN, "bob", "builder");

    await changePassword(jar, { currentPassword: "builder", newPassword: "carpenter" });

    expect(await subsonicStatus("bob", "carpenter")).toBe("ok");
    expect(await subsonicStatus("bob", "builder")).toBe("failed");
    expect((await signIn(send, ORIGIN, "bob", "carpenter")).response.status).toBe(200);
    expect((await signIn(send, ORIGIN, "bob", "builder")).response.status).toBe(401);
  });

  it("takes the largest body two legal passwords can make", async () => {
    // JSON escapes a control character as \uXXXX, six bytes for one UTF-16
    // unit: the most a password of MAX_PASSWORD_LENGTH units can take.
    const current = "\u0001".repeat(MAX_PASSWORD_LENGTH);
    const next = "\u0002".repeat(MAX_PASSWORD_LENGTH);
    await setPassword(database(testEnv), encryptionKey(), bobId, current);
    const { jar } = await signIn(send, ORIGIN, "bob", current);
    const body = { currentPassword: current, newPassword: next };
    expect(JSON.stringify(body).length).toBeGreaterThan(12 * 1024);
    expect(JSON.stringify(body).length).toBeLessThan(MAX_JSON_BODY_BYTES);

    const response = await changePassword(jar, body);

    expect(response.status).toBe(200);
    await expectPasswordInvariant(bobId, next);
  });
});

describe("the limit on wrong current passwords", () => {
  async function wrongAttempt(jar: CookieJar) {
    return changePassword(jar, { currentPassword: "guess", newPassword: "mine" });
  }

  it(`answers 429 after ${MAX_FAILED_PASSWORD_ATTEMPTS} failures, right password or not, writing nothing`, async () => {
    const { jar } = await signIn(send, ORIGIN, "bob", "builder");
    for (let attempt = 0; attempt < MAX_FAILED_PASSWORD_ATTEMPTS; attempt++) {
      expect((await wrongAttempt(jar)).status).toBe(400);
    }
    expect(await attemptRows()).toMatchObject([{ count: MAX_FAILED_PASSWORD_ATTEMPTS }]);

    await expectRefusal(() => wrongAttempt(jar), 429, "rate_limited");
    await expectRefusal(
      () => changePassword(jar, { currentPassword: "builder", newPassword: "fixer" }),
      429,
      "rate_limited",
    );
    expect(await subsonicStatus("bob", "builder")).toBe("ok");
  });

  it("counts per user, whatever the session", async () => {
    for (let attempt = 0; attempt < MAX_FAILED_PASSWORD_ATTEMPTS; attempt++) {
      const { jar } = await signIn(send, ORIGIN, "bob", "builder");
      await wrongAttempt(jar);
    }
    const { jar: fresh } = await signIn(send, ORIGIN, "bob", "builder");
    const { jar: alice } = await signIn(send, ORIGIN, "alice", "wonderland");

    expect((await wrongAttempt(fresh)).status).toBe(429);
    expect(
      (await changePassword(alice, { currentPassword: "wonderland", newPassword: "wonderland" }))
        .status,
    ).toBe(200);
  });

  it("lets the user try again once the window has passed since the last failure", async () => {
    const { jar } = await signIn(send, ORIGIN, "bob", "builder");
    for (let attempt = 0; attempt < MAX_FAILED_PASSWORD_ATTEMPTS; attempt++) {
      await wrongAttempt(jar);
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + PASSWORD_ATTEMPT_WINDOW_MS + 1000);

    // The count starts again at one.
    expect((await wrongAttempt(jar)).status).toBe(400);
    expect(await attemptRows()).toMatchObject([{ count: 1 }]);
    const response = await changePassword(jar, {
      currentPassword: "builder",
      newPassword: "fixer",
    });
    expect(response.status).toBe(200);
  });

  it("keeps its rows where the cron's prune deletes them", async () => {
    expect(PASSWORD_ATTEMPT_WINDOW_MS).toBeLessThanOrEqual(LONGEST_RATE_LIMIT_WINDOW_MS);
    const { jar } = await signIn(send, ORIGIN, "bob", "builder");
    await wrongAttempt(jar);
    const [row] = await attemptRows();

    // Still inside the retention, the row stays; past it, it goes.
    await pruneExpiredAuthRows(
      database(testEnv),
      (row?.lastRequest ?? 0) + RATE_LIMIT_RETENTION_MS,
    );
    expect(await attemptRows()).toHaveLength(1);
    await pruneExpiredAuthRows(
      database(testEnv),
      (row?.lastRequest ?? 0) + RATE_LIMIT_RETENTION_MS + 1,
    );
    expect(await attemptRows()).toEqual([]);
  });
});
