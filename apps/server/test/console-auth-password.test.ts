import {
  consoleAccount,
  consoleSession,
  consoleUser,
  consoleVerification,
  rateLimit,
} from "@stratosonic/db";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyConsolePassword } from "../src/console-auth/password-hash";
import { consoleRequest, type Send, seedConsoleUser, signIn } from "./console-auth-support";
import { encryptionKey, testEnv } from "./support";

/**
 * Better Auth's password hooks are bound to the console users' peppered
 * HMAC-SHA256 (#99, ADR-0007): its default hasher, scrypt, must never run.
 * Each call costs about 100 ms of CPU against the Free plan's 10 ms.
 *
 * The default hasher is `@better-auth/utils/password`, whose `workerd` build
 * runs `node:crypto`'s scrypt. It is replaced here by spies that forward to the
 * real functions. (It is a devDependency so that this file can name it.) The
 * pool loads the Worker, and Better Auth with it, before this file's mocks
 * exist, so the module registry is reset and the Worker's app imported again,
 * which gives Better Auth's own import of the hasher the spies. A control
 * proves the spies see scrypt when the hooks are left out.
 */

vi.mock("@better-auth/utils/password", async (importOriginal) => {
  const real = await importOriginal<typeof import("@better-auth/utils/password")>();
  return {
    ...real,
    hashPassword: vi.fn(real.hashPassword),
    verifyPassword: vi.fn(real.verifyPassword),
  };
});

const ORIGIN = "https://password.stratosonic.test";

let send: Send;
let scrypt: typeof import("@better-auth/utils/password");
let betterAuth: typeof import("better-auth/minimal").betterAuth;
let drizzleAdapter: typeof import("@better-auth/drizzle-adapter").drizzleAdapter;
let createConsoleAuth: typeof import("../src/console-auth/auth").createConsoleAuth;

function scryptCalls(): number {
  return (
    vi.mocked(scrypt.hashPassword).mock.calls.length +
    vi.mocked(scrypt.verifyPassword).mock.calls.length
  );
}

beforeAll(async () => {
  vi.resetModules();
  const { createApp } = await import("../src/app");
  scrypt = await import("@better-auth/utils/password");
  ({ betterAuth } = await import("better-auth/minimal"));
  ({ drizzleAdapter } = await import("@better-auth/drizzle-adapter"));
  ({ createConsoleAuth } = await import("../src/console-auth/auth"));

  const app = createApp();
  send = (request) => app.request(request, undefined, testEnv);
  await seedConsoleUser("Alice", "wonderland");
});

beforeEach(() => {
  vi.mocked(scrypt.hashPassword).mockClear();
  vi.mocked(scrypt.verifyPassword).mockClear();
});

describe("the password hooks", () => {
  it("sign in, refuse a wrong password and refuse an unknown user without running scrypt", async () => {
    const statuses = [
      (await signIn(send, ORIGIN, "alice", "wonderland")).response.status,
      (await signIn(send, ORIGIN, "alice", "wrong")).response.status,
      // The unknown-user path hashes the attempt too, to even out the timing.
      (await signIn(send, ORIGIN, "nobody", "whatever")).response.status,
    ];

    expect(statuses).toEqual([200, 401, 401]);
    expect(scryptCalls()).toBe(0);
  });

  it("change the password without running scrypt either", async () => {
    const { jar } = await signIn(send, ORIGIN, "alice", "wonderland");

    const response = await send(
      consoleRequest(ORIGIN, "/api/account/password", {
        body: { currentPassword: "wonderland", newPassword: "wonderland" },
        jar,
      }),
    );

    expect(response.status).toBe(200);
    expect(scryptCalls()).toBe(0);
  });

  it("hash to the console users' format, which verifies with the console's own routine", async () => {
    const auth = await createConsoleAuth({
      db: testEnv.DB,
      passphrase: encryptionKey(),
      origin: ORIGIN,
    });
    const context = await auth.$context;

    const hashed = await context.password.hash("looking-glass");

    expect(hashed).toMatch(/^hmac-sha256\$v1\$/);
    expect(await verifyConsolePassword(encryptionKey(), hashed, "looking-glass")).toBe(true);
    expect(await context.password.verify({ hash: hashed, password: "looking-glass" })).toBe(true);
    expect(await context.password.verify({ hash: hashed, password: "wrong" })).toBe(false);
    expect(scryptCalls()).toBe(0);
  });

  it("control: the same spies see scrypt when the hooks are left out", async () => {
    const plain = betterAuth({
      baseURL: ORIGIN,
      basePath: "/api/auth",
      secret: "a-secret-for-the-control-instance-only",
      database: drizzleAdapter(drizzle(testEnv.DB), {
        provider: "sqlite",
        schema: {
          user: consoleUser,
          session: consoleSession,
          account: consoleAccount,
          verification: consoleVerification,
          rateLimit,
        },
      }),
      emailAndPassword: { enabled: true },
    });

    const context = await plain.$context;
    await context.password.hash("wonderland");

    expect(scryptCalls()).toBe(1);
  });
});
