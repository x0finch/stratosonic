import {
  consoleAccount,
  consoleSession,
  consoleUser,
  rateLimit,
  subsonicUser,
} from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_JSON_BODY_BYTES } from "../src/api/json-body";
import { createApp } from "../src/app";
import { setConsolePassword } from "../src/console-auth/credentials";
import {
  MAX_PASSWORD_ATTEMPTS,
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
import { MAX_PASSWORD_LENGTH } from "../src/users/validation";
import {
  type CookieJar,
  consoleRequest,
  cost,
  countingD1,
  expectConsolePassword,
  GUEST_ROLE,
  type RecordedStatement,
  SESSION_TOKEN_COOKIE,
  seedConsoleUser,
  shape,
  signIn,
  subsonicPing,
} from "./console-auth-support";
import { encryptionKey, seedUser, testEnv } from "./support";

/**
 * `POST /api/account/password` (#81, #90, #99): a signed-in console user changes
 * their own console password, which ends their other sessions and changes no
 * Subsonic password.
 *
 * Bob is both a console user and, separately, a Subsonic user, with the same
 * name and the same password `builder`. Every test starts with his console
 * password `builder`, no session of his and no failed attempts counted.
 */

const ORIGIN = "https://account.stratosonic.test";
const d1 = countingD1(testEnv.DB);
const env: Env = { ...testEnv, DB: d1.binding };
const app = createApp();
const send = (request: Request) => app.request(request, undefined, env);

let bobId: string;

beforeAll(async () => {
  bobId = await seedConsoleUser("Bob", "builder");
  await seedConsoleUser("Alice", "wonderland", GUEST_ROLE);
  await seedUser("Bob", "builder");
});

beforeEach(async () => {
  // Also ends every session of Bob's.
  await setConsolePassword(database(testEnv), encryptionKey(), bobId, "builder");
  await database(testEnv).delete(rateLimit);
});

afterEach(() => {
  vi.useRealTimers();
});

function changePassword(jar: CookieJar | undefined, body: unknown, headers = {}) {
  return send(consoleRequest(ORIGIN, "/api/account/password", { body, jar, headers }));
}

/** What Subsonic says to Bob's Subsonic user with a password. */
function subsonicBob(password: string) {
  return subsonicPing(send, ORIGIN, "bob", password);
}

async function snapshot() {
  const db = database(testEnv);
  return {
    subsonicUsers: await db.select().from(subsonicUser),
    consoleUsers: await db.select().from(consoleUser),
    accounts: await db.select().from(consoleAccount),
    sessions: await db.select().from(consoleSession),
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
    .select({ id: consoleSession.id })
    .from(consoleSession)
    .where(eq(consoleSession.userId, userId));
  return rows.map((row) => row.id).sort();
}

/** The id of the session a jar is signed in with. */
async function sessionIdOf(jar: CookieJar): Promise<string | undefined> {
  const token = decodeURIComponent(jar.get(SESSION_TOKEN_COOKIE) ?? "").split(".")[0];
  const [row] = await database(testEnv)
    .select({ id: consoleSession.id })
    .from(consoleSession)
    .where(eq(consoleSession.token, token ?? ""));
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

/** The attempts counted for the session a jar is signed in with. */
async function attemptRows(jar: CookieJar) {
  const sessionId = await sessionIdOf(jar);
  const rows = await database(testEnv).select().from(rateLimit);
  return rows.filter((row) => row.key === `${PASSWORD_ATTEMPT_KEY_PREFIX}${sessionId}`);
}

describe("POST /api/account/password", () => {
  it("refuses a wrong current password with 400, writing only the attempt's count", async () => {
    const { jar } = await signIn(send, ORIGIN, "bob", "builder");
    const before = await snapshot();

    let response: Response | undefined;
    const statements = await measured(async () => {
      response = await changePassword(jar, { currentPassword: "Builder", newPassword: "fixer" });
    });

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: "wrong_password" });
    expect(statements.map(shape).slice(-2)).toEqual(["insert rate_limit", "select account"]);
    const after = await snapshot();
    expect({ ...after, rateLimits: [] }).toEqual({ ...before, rateLimits: [] });
    expect(await attemptRows(jar)).toMatchObject([{ count: 1 }]);
    expect(await subsonicBob("builder")).toBe("ok");
  });

  it("refuses a console user whose role does not grant account:change-password", async () => {
    const { jar } = await signIn(send, ORIGIN, "bob", "builder");
    await database(testEnv)
      .update(consoleUser)
      .set({ role: "read-only" })
      .where(eq(consoleUser.id, bobId));

    try {
      // Read fresh from D1, past the cookie cache that still says `full`.
      await expectRefusal(
        () => changePassword(jar, { currentPassword: "builder", newPassword: "fixer" }),
        403,
        "forbidden",
      );
    } finally {
      await database(testEnv)
        .update(consoleUser)
        .set({ role: "owner" })
        .where(eq(consoleUser.id, bobId));
    }
    await expectConsolePassword(bobId, "builder");
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
      "insert rate_limit", // the attempt, counted first, and in one batch
      "select account", // the stored hash
      "update account",
      "delete session",
    ]);
    expect(cost(statements).roundTrips).toBe(4);
    // The session's new counter, with its two keys; the credential account;
    // and the one other session. No Subsonic user row.
    expect(cost(statements).rowsWritten).toBe(3 + 1 + 1);
    expect(await attemptRows(here)).toMatchObject([{ count: 1 }]);

    expect(await sessionIds(bobId)).toEqual([kept]);
    await expectConsolePassword(bobId, "fixer");

    // This session still writes; the other one is refused at once; another
    // console user's session is untouched.
    const again = await changePassword(here, { currentPassword: "fixer", newPassword: "fixer2" });
    expect(again.status).toBe(200);
    const stale = await changePassword(elsewhere, { currentPassword: "fixer2", newPassword: "x" });
    expect(stale.status).toBe(401);
    expect((await send(consoleRequest(ORIGIN, "/api/me", { jar: alice }))).status).toBe(200);
    await expectConsolePassword(bobId, "fixer2");
  });

  it("moves the console to the new password, and leaves Subsonic's as it was", async () => {
    const { jar } = await signIn(send, ORIGIN, "bob", "builder");
    const [subsonicBefore] = await database(testEnv).select().from(subsonicUser);

    await changePassword(jar, { currentPassword: "builder", newPassword: "carpenter" });

    expect((await signIn(send, ORIGIN, "bob", "carpenter")).response.status).toBe(200);
    expect((await signIn(send, ORIGIN, "bob", "builder")).response.status).toBe(401);
    expect(await database(testEnv).select().from(subsonicUser)).toEqual([subsonicBefore]);
    expect(await subsonicBob("builder")).toBe("ok");
    expect(await subsonicBob("carpenter")).toBe(40);
  });

  it("takes the largest body two legal passwords can make", async () => {
    // JSON escapes a control character as \uXXXX, six bytes for one UTF-16
    // unit: the most a password of MAX_PASSWORD_LENGTH units can take.
    const current = "\u0001".repeat(MAX_PASSWORD_LENGTH);
    const next = "\u0002".repeat(MAX_PASSWORD_LENGTH);
    await setConsolePassword(database(testEnv), encryptionKey(), bobId, current);
    const { jar } = await signIn(send, ORIGIN, "bob", current);
    const body = { currentPassword: current, newPassword: next };
    expect(JSON.stringify(body).length).toBeGreaterThan(12 * 1024);
    expect(JSON.stringify(body).length).toBeLessThan(MAX_JSON_BODY_BYTES);

    const response = await changePassword(jar, body);

    expect(response.status).toBe(200);
    await expectConsolePassword(bobId, next);
  });
});

describe("the limit on attempts", () => {
  async function wrongAttempt(jar: CookieJar) {
    return changePassword(jar, { currentPassword: "guess", newPassword: "mine" });
  }

  it(`answers 429 after ${MAX_PASSWORD_ATTEMPTS} attempts, right password or not, writing nothing`, async () => {
    const { jar } = await signIn(send, ORIGIN, "bob", "builder");
    for (let attempt = 0; attempt < MAX_PASSWORD_ATTEMPTS; attempt++) {
      expect((await wrongAttempt(jar)).status).toBe(400);
    }
    expect(await attemptRows(jar)).toMatchObject([{ count: MAX_PASSWORD_ATTEMPTS }]);

    await expectRefusal(() => wrongAttempt(jar), 429, "rate_limited");
    await expectRefusal(
      () => changePassword(jar, { currentPassword: "builder", newPassword: "fixer" }),
      429,
      "rate_limited",
    );
    expect(await subsonicBob("builder")).toBe("ok");
  });

  it("counts per session, so a stolen one cannot lock its console user out", async () => {
    const { jar: thief } = await signIn(send, ORIGIN, "bob", "builder");
    const { jar: victim } = await signIn(send, ORIGIN, "bob", "builder");
    for (let attempt = 0; attempt < MAX_PASSWORD_ATTEMPTS; attempt++) {
      await wrongAttempt(thief);
    }
    expect((await wrongAttempt(thief)).status).toBe(429);

    // The victim changes the password, which ends the thief's session.
    const response = await changePassword(victim, {
      currentPassword: "builder",
      newPassword: "fixer",
    });
    expect(response.status).toBe(200);
    expect((await wrongAttempt(thief)).status).toBe(401);
  });

  it(`lets at most ${MAX_PASSWORD_ATTEMPTS} of a parallel burst reach the password check`, async () => {
    const { jar } = await signIn(send, ORIGIN, "bob", "builder");

    const responses = await Promise.all(Array.from({ length: 10 }, () => wrongAttempt(jar)));

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 400)).toHaveLength(MAX_PASSWORD_ATTEMPTS);
    expect(statuses.filter((status) => status === 429)).toHaveLength(10 - MAX_PASSWORD_ATTEMPTS);
    expect(await attemptRows(jar)).toMatchObject([{ count: MAX_PASSWORD_ATTEMPTS }]);
  });

  it("lets the session try again once the window has passed since its last attempt", async () => {
    const { jar } = await signIn(send, ORIGIN, "bob", "builder");
    for (let attempt = 0; attempt < MAX_PASSWORD_ATTEMPTS; attempt++) {
      await wrongAttempt(jar);
    }

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + PASSWORD_ATTEMPT_WINDOW_MS + 1000);

    // The count starts again at one.
    expect((await wrongAttempt(jar)).status).toBe(400);
    expect(await attemptRows(jar)).toMatchObject([{ count: 1 }]);
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
    const [row] = await attemptRows(jar);

    // Still inside the retention, the row stays; past it, it goes.
    await pruneExpiredAuthRows(
      database(testEnv),
      (row?.lastRequest ?? 0) + RATE_LIMIT_RETENTION_MS,
    );
    expect(await attemptRows(jar)).toHaveLength(1);
    await pruneExpiredAuthRows(
      database(testEnv),
      (row?.lastRequest ?? 0) + RATE_LIMIT_RETENTION_MS + 1,
    );
    expect(await attemptRows(jar)).toEqual([]);
  });
});
