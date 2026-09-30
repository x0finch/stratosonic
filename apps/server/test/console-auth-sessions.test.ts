import { SELF } from "cloudflare:test";
import { operatorSession } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { setOperatorPassword } from "../src/console-auth/credentials";
import {
  type ConsoleEnv,
  loadConsoleAuth,
  requireFreshSession,
  requireSession,
} from "../src/console-auth/middleware";
import { database } from "../src/db";
import type { Env } from "../src/env";
import {
  type CookieJar,
  consoleRequest,
  cost,
  countingD1,
  expectOperatorPassword,
  type RecordedStatement,
  SESSION_DATA_COOKIE,
  seedOperator,
  shape,
  signIn,
  subsonicPing,
} from "./console-auth-support";
import { BASE, encryptionKey, testEnv } from "./support";

/**
 * Console sessions against D1 (#81, #89): what each check costs with the
 * compact cookie cache on, and which checks see a revocation at once.
 *
 * Requests go to the Worker's app over a D1 binding that counts every
 * statement. The origin is this file's own, so the isolate's Better Auth
 * instance for it is built over that binding.
 */

const ORIGIN = "https://sessions.stratosonic.test";
const d1 = countingD1(testEnv.DB);
const env: Env = { ...testEnv, DB: d1.binding };
const app = createApp();
const send = (request: Request) => app.request(request, undefined, env);

/**
 * The guards later tickets put on their routes, on a route of their own: a
 * read behind the cache, and a write behind a fresh read. Operators have no
 * roles, so a session is all either checks.
 */
const guarded = new Hono<ConsoleEnv>()
  .use(loadConsoleAuth)
  .get("/read", requireSession, (c) => c.json(c.var.session))
  .post("/write", requireFreshSession, (c) => c.json(c.var.session));
const sendGuarded = (request: Request) => guarded.request(request, undefined, env);

let aliceId: string;

beforeAll(async () => {
  aliceId = await seedOperator("Alice", "wonderland");
  await seedOperator("Bob", "builder");
});

afterEach(() => {
  vi.useRealTimers();
});

/** Runs `action`, and answers the statements it sent to D1. */
async function measured(action: () => unknown): Promise<RecordedStatement[]> {
  d1.reset();
  await action();
  return [...d1.statements];
}

async function me(jar: CookieJar) {
  const response = await send(consoleRequest(ORIGIN, "/api/me", { jar }));
  jar.absorb(response);
  return response;
}

/** Moves the clock past the cookie cache's 5 minutes. */
function afterCookieCacheExpiry(minutes = 6) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + minutes * 60 * 1000);
}

async function aliceSessions(): Promise<number> {
  const rows = await database(testEnv)
    .select()
    .from(operatorSession)
    .where(eq(operatorSession.userId, aliceId));
  return rows.length;
}

describe("the D1 cost of a session", () => {
  it("sign-in reads the limiter, the operator and the account, and writes one session", async () => {
    let jar: CookieJar | undefined;
    const statements = await measured(async () => {
      ({ jar } = await signIn(send, ORIGIN, "alice", "wonderland"));
    });

    expect(jar?.names()).toContain(SESSION_DATA_COOKIE);
    expect(statements.map(shape)).toEqual([
      "select rate_limit", // this address's counter for /sign-in/username
      "insert rate_limit", // its first attempt; later ones update the row
      "select operator", // by the generated `username` column
      "select operator_account", // the credential account
      "insert operator_session",
    ]);
  });

  it("a cached session check makes no D1 query at all", async () => {
    const { jar } = await signIn(send, ORIGIN, "alice", "wonderland");

    const statements = await measured(async () => {
      for (let check = 0; check < 5; check++) {
        expect((await me(jar)).status).toBe(200);
      }
    });

    expect(statements).toEqual([]);
  });

  it("past the cache's 5 minutes it reads the session and operator, then caches again", async () => {
    const { jar } = await signIn(send, ORIGIN, "alice", "wonderland");
    afterCookieCacheExpiry();

    let response: Response | undefined;
    const expired = await measured(async () => {
      response = await me(jar);
    });
    const recached = await measured(() => me(jar));

    expect(response?.status).toBe(200);
    expect(expired.map(shape)).toEqual(["select operator_session", "select operator"]);
    expect(cost(expired).rowsWritten).toBe(0);
    // The middleware passes Better Auth's re-cached cookie on to the browser,
    // or every later check would read D1 again.
    expect(response?.headers.getSetCookie().join("\n")).toMatch(
      /^__Secure-better-auth\.session_data=/m,
    );
    expect(recached).toEqual([]);
  });

  it("a day on (updateAge), a check also extends the session row", async () => {
    const { jar } = await signIn(send, ORIGIN, "alice", "wonderland");
    afterCookieCacheExpiry(24 * 60 + 1);

    const statements = await measured(() => me(jar));

    expect(statements.map(shape)).toEqual([
      "select operator_session",
      "select operator",
      "update operator_session",
    ]);
  });

  it("sign-out reads the session twice and deletes it", async () => {
    const { jar } = await signIn(send, ORIGIN, "alice", "wonderland");

    const statements = await measured(() =>
      send(consoleRequest(ORIGIN, "/api/auth/sign-out", { body: {}, jar })),
    );

    expect(statements.map(shape)).toEqual([
      "select operator_session", // the session by token...
      "select operator", // ...and its operator
      "select operator_session", // deleteSession reads the row it deletes
      "delete operator_session",
      "select operator_account", // the accounts, for social providers' sign-out URLs
    ]);
  });

  it("setOperatorPassword revokes the sessions in the same single round trip", async () => {
    await signIn(send, ORIGIN, "alice", "wonderland");
    await signIn(send, ORIGIN, "alice", "wonderland");

    const statements = await measured(() =>
      setOperatorPassword(drizzle(d1.binding), encryptionKey(), aliceId, "wonderland"),
    );

    expect(cost(statements).roundTrips).toBe(1);
    expect(statements.map(shape)).toEqual(["update operator_account", "delete operator_session"]);
    expect(await aliceSessions()).toBe(0);
  });
});

describe("requireSession and requireFreshSession", () => {
  it("answer who is signed in, the first from the cache", async () => {
    const { jar } = await signIn(send, ORIGIN, "alice", "wonderland");

    const read = await measured(async () => {
      const response = await sendGuarded(consoleRequest(ORIGIN, "/read", { jar }));
      expect(await response.json()).toEqual({
        id: expect.any(String),
        userId: aliceId,
        username: "Alice",
      });
    });
    const write = await measured(async () => {
      const response = await sendGuarded(consoleRequest(ORIGIN, "/write", { body: {}, jar }));
      expect(await response.json()).toMatchObject({ userId: aliceId, username: "Alice" });
    });

    expect(read).toEqual([]);
    expect(write.map(shape)).toEqual(["select operator_session", "select operator"]);
  });

  it("see a deleted session: the fresh check at once, the cached one after 5 minutes", async () => {
    const { jar } = await signIn(send, ORIGIN, "alice", "wonderland");
    await database(testEnv).delete(operatorSession).where(eq(operatorSession.userId, aliceId));

    const read = await sendGuarded(consoleRequest(ORIGIN, "/read", { jar }));
    const write = await sendGuarded(consoleRequest(ORIGIN, "/write", { body: {}, jar }));

    expect(read.status).toBe(200);
    expect(write.status).toBe(401);
    expect(await write.json()).toEqual({ error: "unauthenticated" });

    afterCookieCacheExpiry();
    expect((await sendGuarded(consoleRequest(ORIGIN, "/read", { jar }))).status).toBe(401);
  });

  it("answer 401 without a session", async () => {
    for (const [method, path] of [
      ["GET", "/read"],
      ["POST", "/write"],
    ] as const) {
      const response = await sendGuarded(consoleRequest(ORIGIN, path, { method }));
      expect(response.status, path).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthenticated" });
    }
  });
});

describe("a session deleted while it is being checked", () => {
  /**
   * A D1 that deletes a session just before Better Auth extends it, as a
   * sign-out or a password change landing mid-check would. Better Auth then
   * finds nothing to update and throws UNAUTHORIZED instead of answering null.
   * The update names the session by its token, its last parameter.
   */
  function racingD1(inner: D1Database): D1Database {
    const racing = (statement: D1PreparedStatement, token?: unknown): D1PreparedStatement => {
      const deleteFirst =
        <T>(run: () => Promise<T>) =>
        async () => {
          await inner.prepare("DELETE FROM operator_session WHERE token = ?").bind(token).run();
          return run();
        };
      return {
        bind: (...values: unknown[]) => racing(statement.bind(...values), values.at(-1)),
        all: deleteFirst(() => statement.all()),
        run: deleteFirst(() => statement.run()),
        raw: deleteFirst(() => statement.raw()),
        first: deleteFirst(() => statement.first()),
      } as unknown as D1PreparedStatement;
    };

    return new Proxy(inner, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) =>
            /^update "operator_session"/i.test(sql)
              ? racing(target.prepare(sql))
              : target.prepare(sql);
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  it("is a 401, not the error handler's 500", async () => {
    const origin = "https://racing.stratosonic.test";
    const racingEnv: Env = { ...testEnv, DB: racingD1(testEnv.DB) };
    const signInRacing = (request: Request) => app.request(request, undefined, racingEnv);
    const sendRacing = (request: Request) => guarded.request(request, undefined, racingEnv);
    const reader = await signIn(signInRacing, origin, "alice", "wonderland");
    const writer = await signIn(signInRacing, origin, "alice", "wonderland");
    // Past `updateAge`, so each check extends its session and meets the race.
    afterCookieCacheExpiry(24 * 60 + 1);

    for (const [method, path, jar] of [
      ["GET", "/read", reader.jar],
      ["POST", "/write", writer.jar],
    ] as const) {
      const response = await sendRacing(consoleRequest(origin, path, { method, jar }));
      expect(response.status, path).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthenticated" });
    }
  });
});

describe("a password set with setOperatorPassword", () => {
  it("signs in to the console, never to Subsonic, and the old one no longer does", async () => {
    const { jar } = await signIn(send, ORIGIN, "alice", "wonderland");
    const current = (await (
      await sendGuarded(consoleRequest(ORIGIN, "/read", { jar }))
    ).json()) as { id: string };
    const other = await signIn(send, ORIGIN, "alice", "wonderland");

    await setOperatorPassword(database(testEnv), encryptionKey(), aliceId, "looking-glass", {
      keepSessionId: current.id,
    });

    await expectOperatorPassword(aliceId, "looking-glass");
    expect((await signIn(send, ORIGIN, "alice", "looking-glass")).response.status).toBe(200);
    expect((await signIn(send, ORIGIN, "alice", "wonderland")).response.status).toBe(401);
    expect(
      await subsonicPing((request) => SELF.fetch(request), BASE, "alice", "looking-glass"),
    ).toBe(40);
    expect(await subsonicPing((request) => SELF.fetch(request), BASE, "alice", "wonderland")).toBe(
      40,
    );

    // The kept session still writes; the other one is gone.
    expect((await sendGuarded(consoleRequest(ORIGIN, "/write", { body: {}, jar }))).status).toBe(
      200,
    );
    expect(
      (await sendGuarded(consoleRequest(ORIGIN, "/write", { body: {}, jar: other.jar }))).status,
    ).toBe(401);
  });
});
