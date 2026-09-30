import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { consoleAuth, deriveSessionSecret, MAX_CACHED_INSTANCES } from "../src/console-auth/auth";
import type { Env } from "../src/env";
import {
  CookieJar,
  consoleRequest,
  SESSION_DATA_COOKIE,
  seedConsoleUser,
  signIn,
} from "./console-auth-support";
import { BASE, encryptionKey, testEnv } from "./support";

/**
 * How the console's Better Auth is configured and built (#81, #89): the key it
 * needs, the secret it derives, one instance per isolate, the cookies for a
 * plain-http origin, and the `/api` error handler.
 */

const app = createApp();
const sendWith = (env: Env) => (request: Request) => app.request(request, undefined, env);

beforeAll(async () => {
  await seedConsoleUser("Alice", "wonderland");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("without PASSWORD_ENCRYPTION_KEY", () => {
  const unconfigured: Env = { ...testEnv, PASSWORD_ENCRYPTION_KEY: undefined };

  it.each([
    ["GET", "/api/me"],
    ["GET", "/api/auth/get-session"],
    ["POST", "/api/auth/sign-in/username"],
    ["GET", "/api/nope"],
  ])("answers %s %s with 503 not_configured", async (method, path) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await sendWith(unconfigured)(
      consoleRequest("https://unconfigured.stratosonic.test", path, {
        method,
        body: method === "POST" ? { username: "alice", password: "wonderland" } : undefined,
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not_configured" });
  });

  it("never derives a session secret from an empty passphrase", async () => {
    await expect(deriveSessionSecret("")).rejects.toThrow(/empty passphrase/);
  });
});

describe("the session secret", () => {
  it("is derived with HKDF from PASSWORD_ENCRYPTION_KEY, distinct from the AES key", async () => {
    const secret = await deriveSessionSecret(encryptionKey());
    const aesKey = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encryptionKey())),
    );
    const aesHex = Array.from(aesKey, (byte) => byte.toString(16).padStart(2, "0")).join("");

    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await deriveSessionSecret(encryptionKey())).toBe(secret);
    expect(secret).not.toBe(aesHex);
    expect(await deriveSessionSecret("another-passphrase")).not.toBe(secret);
  });
});

describe("the instance", () => {
  it("is built once per isolate for an origin", async () => {
    const options = { db: testEnv.DB, passphrase: encryptionKey(), origin: BASE };

    expect(await consoleAuth(options)).toBe(await consoleAuth(options));
    expect(await consoleAuth({ ...options, origin: "http://localhost:8787" })).not.toBe(
      await consoleAuth(options),
    );
  });

  it(`keeps no more than ${MAX_CACHED_INSTANCES} origins' instances, dropping the oldest`, async () => {
    const options = (origin: string) => ({ db: testEnv.DB, passphrase: encryptionKey(), origin });
    const first = await consoleAuth(options("https://first.stratosonic.test"));
    const second = await consoleAuth(options("https://second.stratosonic.test"));

    // Enough newer origins to push the first out, and only the first.
    for (let index = 0; index < MAX_CACHED_INSTANCES - 1; index++) {
      await consoleAuth(options(`https://origin-${index}.stratosonic.test`));
    }

    expect(await consoleAuth(options("https://second.stratosonic.test"))).toBe(second);
    const rebuilt = await consoleAuth(options("https://first.stratosonic.test"));
    expect(rebuilt).not.toBe(first);
    expect(await consoleAuth(options("https://first.stratosonic.test"))).toBe(rebuilt);
  });

  it("drops the __Secure- prefix and Secure only for a plain-http origin (wrangler dev)", async () => {
    const { response } = await signIn(
      sendWith(testEnv),
      "http://localhost:8787",
      "alice",
      "wonderland",
    );

    expect(response.status).toBe(200);
    for (const cookie of response.headers.getSetCookie()) {
      expect(cookie).toMatch(/^better-auth\.session_(token|data)=/);
      expect(cookie).not.toMatch(/; Secure/);
      expect(cookie).toMatch(/; HttpOnly/);
    }
  });

  it.each(["http://127.0.0.1:8787", "http://[::1]:8787"])(
    "serves the other loopback address %s over plain http too",
    async (origin) => {
      expect((await signIn(sendWith(testEnv), origin, "alice", "wonderland")).response.status).toBe(
        200,
      );
    },
  );

  it.each([
    ["GET", "/api/me"],
    ["GET", "/api/auth/get-session"],
    ["POST", "/api/auth/sign-in/username"],
    ["GET", "/api/nope"],
  ])("refuses %s %s over plain http from any other host", async (method, path) => {
    const response = await sendWith(testEnv)(
      consoleRequest("http://stratosonic.test", path, {
        method,
        body: method === "POST" ? { username: "alice", password: "wonderland" } : undefined,
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "insecure_origin" });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("trusts its own origin only, not even another origin of the same Worker", async () => {
    const response = await sendWith(testEnv)(
      consoleRequest("http://localhost:8787", "/api/auth/sign-in/username", {
        body: { username: "alice", password: "wonderland" },
        headers: { origin: BASE, cookie: "unrelated=1" },
      }),
    );

    expect(response.status).toBe(403);
  });
});

describe("the /api error handler", () => {
  it("answers a failing handler with 500 internal, and no stack", async () => {
    // A session cookie signed with the right secret, but no cached copy, so
    // the check has to ask D1 - which is down.
    const { jar } = await signIn(sendWith(testEnv), BASE, "alice", "wonderland");
    jar.delete(SESSION_DATA_COOKIE);
    const unavailable: Env = {
      ...testEnv,
      DB: {
        prepare() {
          throw new Error("D1_ERROR: database is unavailable");
        },
      } as unknown as D1Database,
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await sendWith(unavailable)(
      consoleRequest("https://down.stratosonic.test", "/api/me", { jar }),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "internal" });
    expect(body).not.toMatch(/D1_ERROR|at /);
  });

  it("is not reached by an unknown session, which is a 401", async () => {
    const response = await sendWith(testEnv)(
      consoleRequest(BASE, "/api/me", { jar: new CookieJar() }),
    );

    expect(response.status).toBe(401);
  });
});
