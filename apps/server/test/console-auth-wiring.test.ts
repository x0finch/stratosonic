/**
 * SPIKE #86, question 6: Better Auth mounted in the Worker - the route, the
 * cookies it sets, the origin check, the rate limiter and the secret.
 */

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { consoleAuth, createConsoleAuth, deriveAuthSecret } from "../src/console-auth/auth";
import {
  AUTH_ORIGIN,
  authRequest,
  CookieJar,
  countedAuth,
  createUser,
  totals,
} from "./console-auth-support";
import { encryptionKey, testEnv } from "./support";

function workerRequest(path: string, init: RequestInit & { origin?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("origin", init.origin ?? AUTH_ORIGIN);
  headers.set("cf-connecting-ip", "192.0.2.10");
  return SELF.fetch(`${AUTH_ORIGIN}/api/auth${path}`, { ...init, headers });
}

describe("question 6: wiring", () => {
  it("serves /api/auth/* from the Worker, and the first-run admin can sign in", async () => {
    // The bootstrap admin (INITIAL_USER / INITIAL_PASSWORD) gets its
    // credential account in the same batch as its user row.
    const response = await workerRequest("/sign-in/username", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "ADMIN", password: "sesame" }),
    });
    expect(response.status).toBe(200);

    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/^__Secure-better-auth\.session_(token|data)=/);
      expect(cookie).toMatch(/; Secure/);
      expect(cookie).toMatch(/; HttpOnly/);
      expect(cookie).toMatch(/; SameSite=Lax/);
      expect(cookie).toMatch(/; Path=\//);
    }

    const jar = new CookieJar();
    jar.absorb(response);
    const session = await workerRequest("/get-session", { headers: { cookie: jar.header() } });
    expect(await session.json()).toMatchObject({
      user: { displayUsername: "admin", isAdmin: true },
    });
  });

  it("refuses a sign-in posted from another origin", async () => {
    const response = await workerRequest("/sign-in/username", {
      method: "POST",
      origin: "https://evil.example",
      headers: { "content-type": "application/json", cookie: "x=1" },
      body: JSON.stringify({ username: "admin", password: "sesame" }),
    });

    expect(response.status).toBe(403);
  });

  it("drops the Secure prefix only for a plain-http base URL (wrangler dev)", async () => {
    await createUser("Dev", "local");
    const auth = createConsoleAuth(testEnv, {
      secret: await deriveAuthSecret(encryptionKey()),
      baseURL: "http://localhost:8787",
    });
    const response = await auth.handler(
      new Request("http://localhost:8787/api/auth/sign-in/username", {
        method: "POST",
        headers: {
          origin: "http://localhost:8787",
          "content-type": "application/json",
          "cf-connecting-ip": "192.0.2.11",
        },
        body: JSON.stringify({ username: "dev", password: "local" }),
      }),
    );

    const [token] = response.headers.getSetCookie();
    expect(token).toMatch(/^better-auth\.session_token=/);
    expect(token).not.toMatch(/; Secure/);
  });

  it("keeps one instance per isolate", async () => {
    expect(await consoleAuth(testEnv, AUTH_ORIGIN)).toBe(await consoleAuth(testEnv, AUTH_ORIGIN));
  });

  it("derives a stable secret of its own from PASSWORD_ENCRYPTION_KEY", async () => {
    const secret = await deriveAuthSecret(encryptionKey());
    const aesKey = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encryptionKey()));
    const aesHex = Array.from(new Uint8Array(aesKey), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await deriveAuthSecret(encryptionKey())).toBe(secret);
    expect(secret).not.toBe(aesHex);
    expect(await deriveAuthSecret("another-key")).not.toBe(secret);
  });
});

describe("question 6: the rate limiter", () => {
  it("allows five sign-ins a minute per address, then answers 429", async () => {
    await createUser("Limited", "pw");
    const { auth, d1 } = await countedAuth();
    const attempt = () =>
      auth.handler(
        authRequest("/sign-in/username", {
          body: { username: "limited", password: "wrong" },
          headers: { "cf-connecting-ip": "203.0.113.99" },
        }),
      );

    const statuses: number[] = [];
    const costs: ReturnType<typeof totals>[] = [];
    for (let index = 0; index < 7; index++) {
      d1.reset();
      statuses.push((await attempt()).status);
      const limiter = d1.queries.filter((query) => query.sql.includes('"rate_limit"'));
      costs.push(totals(limiter));
    }
    console.log(`[#86] limiter cost per attempt: ${JSON.stringify(costs)}`);

    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
    // First attempt: read + insert. Later ones: read + conditional update.
    expect(costs.map((cost) => cost.statements)).toEqual([2, 2, 2, 2, 2, 3, 3]);
  });

  it("never limits, or reads the limiter for, a session check", async () => {
    const { auth, d1 } = await countedAuth();
    d1.reset();
    for (let index = 0; index < 20; index++) {
      const response = await auth.handler(
        authRequest("/get-session", { headers: { "cf-connecting-ip": "203.0.113.98" } }),
      );
      expect(response.status).toBe(200);
    }

    expect(d1.queries).toEqual([]);
  });

  it("without a client address every caller shares one bucket", async () => {
    const { auth } = await countedAuth();
    const anonymous = () =>
      auth.handler(
        new Request(`${AUTH_ORIGIN}/api/auth/sign-in/username`, {
          method: "POST",
          headers: { origin: AUTH_ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ username: "nobody", password: "x" }),
        }),
      );

    const statuses: number[] = [];
    for (let index = 0; index < 6; index++) {
      statuses.push((await anonymous()).status);
    }

    // Which is why `ipAddressHeaders` must name `cf-connecting-ip`: the
    // default, `x-forwarded-for`, is absent on Workers.
    expect(statuses.at(-1)).toBe(429);
  });
});
