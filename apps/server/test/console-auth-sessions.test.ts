/**
 * SPIKE #86, questions 4 and 5: what each session operation costs in D1 with
 * the compact cookie cache on, and how our own code creates users, sets
 * passwords and revokes sessions with public sign-up off.
 */

import { account, session, user } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ConsoleAuth } from "../src/console-auth/auth";
import { setPasswordAndRevokeSessions } from "../src/console-auth/credentials";
import { database } from "../src/db";
import {
  authRequest,
  CookieJar,
  type CountingD1,
  countedAuth,
  createUser,
  only,
  totals,
} from "./console-auth-support";
import { encryptionKey, testEnv } from "./support";

let auth: ConsoleAuth;
let d1: CountingD1;
let aliceId: string;

const SESSION_DATA = "__Secure-better-auth.session_data";
const SESSION_TOKEN = "__Secure-better-auth.session_token";

beforeAll(async () => {
  ({ auth, d1 } = await countedAuth());
  aliceId = await createUser("Alice", "wonderland", true);
});

afterEach(() => {
  vi.useRealTimers();
});

async function signIn(username = "alice", password = "wonderland") {
  const jar = new CookieJar();
  const response = await auth.handler(
    authRequest("/sign-in/username", { body: { username, password } }),
  );
  jar.absorb(response);
  expect(response.status).toBe(200);
  return jar;
}

async function getSession(jar: CookieJar, query = "") {
  const response = await auth.handler(authRequest(`/get-session${query}`, { jar }));
  jar.absorb(response);
  return (await response.json()) as { user: { id: string } } | null;
}

/** A statement as "<verb> <table>". */
function shape(query: { sql: string }): string {
  const verb = query.sql.split(" ")[0];
  const table = query.sql.match(/(?:from|into|update) "(\w+)"/)?.[1];
  return `${verb} ${table}`;
}

/** Runs `action` and returns the statements it sent, printed for the report. */
async function measured(label: string, action: () => Promise<unknown>) {
  d1.reset();
  await action();
  const queries = [...d1.queries];
  console.log(
    `[#86] ${label}: ${JSON.stringify(totals(queries))}\n${queries
      .map(
        (query) => `  #${query.roundTrip} r=${query.rowsRead} w=${query.rowsWritten} ${query.sql}`,
      )
      .join("\n")}`,
  );
  return { queries, ...totals(queries) };
}

describe("question 4: sessions with the compact cookie cache", () => {
  it("sign-in reads the user, the account and the limiter, and writes one session", async () => {
    let jar = new CookieJar();
    const cost = await measured("sign-in", async () => {
      jar = await signIn();
    });

    expect(jar.names().sort()).toEqual([SESSION_DATA, SESSION_TOKEN]);
    expect(cost.queries.map(shape)).toEqual([
      "select rate_limit", // the limiter's row for this address and path
      "insert rate_limit", // first attempt from this address (later ones update)
      "select user", // by the generated username column
      "select account", // the credential account
      "insert session",
    ]);
  });

  it("a session check inside maxAge touches D1 zero times", async () => {
    const jar = await signIn();

    const cost = await measured("get-session (cached)", async () => {
      for (let check = 0; check < 5; check++) {
        expect((await getSession(jar))?.user.id).toBe(aliceId);
      }
    });

    expect(cost.statements).toBe(0);
  });

  it("a session check past maxAge reads the session and user, then re-caches", async () => {
    const jar = await signIn();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);

    const cost = await measured("get-session (cache expired)", async () => {
      expect((await getSession(jar))?.user.id).toBe(aliceId);
    });
    const again = await measured("get-session (re-cached)", async () => {
      expect((await getSession(jar))?.user.id).toBe(aliceId);
    });

    expect(cost.queries.map(shape)).toEqual(["select session", "select user"]);
    expect(cost.rowsWritten).toBe(0);
    expect(again.statements).toBe(0);
  });

  it("a refresh after updateAge (one day) rewrites the session row", async () => {
    const jar = await signIn();
    const before = await database(testEnv)
      .select({ expiresAt: session.expiresAt })
      .from(session)
      .where(eq(session.userId, aliceId));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000 + 60 * 1000);

    const cost = await measured("get-session (refresh)", async () => {
      expect((await getSession(jar))?.user.id).toBe(aliceId);
    });

    expect(cost.queries.map(shape)).toEqual(["select session", "select user", "update session"]);
    expect(cost.queries[2]?.sql).toMatch(
      /^update "session" set "expires_at" = \?, "updated_at" = \?/,
    );
    expect(cost.rowsWritten).toBeGreaterThanOrEqual(1);
    expect(before.length).toBeGreaterThan(0);
  });

  it("sign-out deletes the session row and clears both cookies", async () => {
    const jar = await signIn();
    const token = decodeURIComponent(jar.get(SESSION_TOKEN) ?? "").split(".")[0] ?? "";

    const cost = await measured("sign-out", async () => {
      const response = await auth.handler(authRequest("/sign-out", { body: {}, jar }));
      expect(response.status).toBe(200);
      jar.absorb(response);
    });

    expect(jar.names()).toEqual([]);
    expect(await database(testEnv).select().from(session).where(eq(session.token, token))).toEqual(
      [],
    );
    expect(cost.queries.map(shape)).toEqual([
      "select session", // findSession: the session by token...
      "select user", // ...and its user (no join without experimental.joins)
      "select session", // deleteSession reads the row it is about to delete
      "delete session",
      "select account", // accounts, for social providers' logout URLs
    ]);
  });
});

describe("question 5: users, passwords and sessions from our own code", () => {
  it("public sign-up is refused even when called server-side", async () => {
    await expect(
      auth.api.signUpEmail({
        body: { email: "bob@users.invalid", password: "builder", name: "Bob" },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("the internal adapter can create a user and credential account through the mapping", async () => {
    const context = await auth.$context;
    const created = await context.internalAdapter.createUser(
      {
        name: "Bob",
        // Better Auth insists on an email; the column is generated, so Drizzle
        // leaves it out of the insert and the returned row carries the derived one.
        email: "ignored@example.com",
        emailVerified: false,
        displayUsername: "Bob",
      } as Parameters<typeof context.internalAdapter.createUser>[0],
      { method: "admin" },
    );
    await context.internalAdapter.linkAccount({
      userId: created.id,
      providerId: "credential",
      accountId: created.id,
      password: await context.password.hash("builder"),
    });

    expect(created).toMatchObject({ email: "bob@users.invalid", username: "bob", isAdmin: false });
    // ...but user.password stays empty, so the Subsonic side cannot log Bob
    // in: this path splits the two credentials, which is why the prototype
    // writes users itself (console-auth/credentials.ts).
    const row = only(
      await database(testEnv)
        .select({ password: user.password })
        .from(user)
        .where(eq(user.id, created.id)),
    );
    expect(row.password).toBe("");
    expect((await signIn("bob", "builder")).get(SESSION_TOKEN)).toBeDefined();
  });

  it("internalAdapter.updatePassword writes account.password only", async () => {
    const bobId = await createUser("Carol", "first");
    const context = await auth.$context;
    await context.internalAdapter.updatePassword(bobId, await context.password.hash("second"));

    const userRow = only(
      await database(testEnv)
        .select({ password: user.password })
        .from(user)
        .where(eq(user.id, bobId)),
    );
    const accountRow = only(
      await database(testEnv)
        .select({ password: account.password })
        .from(account)
        .where(eq(account.userId, bobId)),
    );
    expect(accountRow.password).not.toBe(userRow.password);
  });

  it("a password change revokes every session row in the same batch", async () => {
    const first = await signIn();
    const second = await signIn();

    const cost = await measured("set password + revoke", () =>
      setPasswordAndRevokeSessions(drizzle(d1.binding), encryptionKey(), aliceId, "new-password"),
    );
    // One round trip: D1 runs a batch as a single transaction.
    expect(cost.roundTrips).toBe(1);
    expect(cost.queries.map(shape)).toEqual(["update user", "update account", "delete session"]);

    const rows = await database(testEnv).select().from(session).where(eq(session.userId, aliceId));
    expect(rows).toEqual([]);

    // RISK: the cookie cache still vouches for the revoked session until its
    // maxAge runs out. A route that must not trust it asks for a fresh read.
    expect((await getSession(first))?.user.id).toBe(aliceId);
    expect(await getSession(second, "?disableCookieCache=true")).toBeNull();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    expect(await getSession(first)).toBeNull();

    await setPasswordAndRevokeSessions(database(testEnv), encryptionKey(), aliceId, "wonderland");
  });

  it("internalAdapter.deleteUserSessions is the Better Auth call for the same revocation", async () => {
    const jar = await signIn();
    const context = await auth.$context;

    await context.internalAdapter.deleteUserSessions(aliceId);

    expect(await getSession(jar, "?disableCookieCache=true")).toBeNull();
  });

  it("setPassword needs the user's own session, so an admin reset cannot use it", async () => {
    await expect(
      auth.api.setPassword({ body: { newPassword: "x" }, headers: new Headers() }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});
