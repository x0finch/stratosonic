import { rateLimit } from "@stratosonic/db";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { consoleRequest, countingD1, seedConsoleUser, signIn } from "./console-auth-support";
import { testEnv } from "./support";

/**
 * The sign-in rate limit (#81): 5 attempts a minute per client address, kept
 * in D1, on `/sign-in/*` only, and keyed by `cf-connecting-ip`.
 */

const ORIGIN = "https://limits.stratosonic.test";
const d1 = countingD1(testEnv.DB);
const env: Env = { ...testEnv, DB: d1.binding };
const app = createApp();
const send = (request: Request) => app.request(request, undefined, env);

function attempt(address: string, password = "wrong") {
  return send(
    consoleRequest(ORIGIN, "/api/auth/sign-in/username", {
      body: { username: "alice", password },
      headers: { "cf-connecting-ip": address },
    }),
  );
}

beforeAll(async () => {
  await seedConsoleUser("Alice", "wonderland");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the sign-in rate limit", () => {
  it("refuses the 6th sign-in within 60 seconds from one address", async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 6; index++) {
      statuses.push((await attempt("203.0.113.1")).status);
    }

    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    // Even with the right password.
    expect((await attempt("203.0.113.1", "wonderland")).status).toBe(429);
  });

  it("counts each address on its own", async () => {
    expect((await attempt("203.0.113.2", "wonderland")).status).toBe(200);
  });

  it("lets the address in again once the minute is over", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61 * 1000);

    expect((await attempt("203.0.113.1", "wonderland")).status).toBe(200);
  });

  it("never reads or writes a counter for a session check", async () => {
    const { jar } = await signIn(send, ORIGIN, "alice", "wonderland");
    const before = await database(testEnv).select().from(rateLimit);
    d1.reset();

    for (let index = 0; index < 10; index++) {
      const headers = { "cf-connecting-ip": "203.0.113.3" };
      expect((await send(consoleRequest(ORIGIN, "/api/me", { jar, headers }))).status).toBe(200);
      expect(
        (await send(consoleRequest(ORIGIN, "/api/auth/get-session", { jar, headers }))).status,
      ).toBe(200);
    }

    expect(d1.statements.filter((statement) => statement.sql.includes('"rate_limit"'))).toEqual([]);
    expect(await database(testEnv).select().from(rateLimit)).toEqual(before);
  });

  it("keys the counter by address and path", async () => {
    const keys = (await database(testEnv).select({ key: rateLimit.key }).from(rateLimit)).map(
      (row) => row.key,
    );

    expect(keys).toContain("203.0.113.1|/sign-in/username");
    expect(keys.some((key) => key.startsWith("no-trusted-ip"))).toBe(false);
  });
});
