import { account, rateLimit, session, user, verification } from "@stratosonic/db";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Send, signIn } from "./console-auth-support";
import { seedUser, testEnv } from "./support";

/**
 * Better Auth's password hooks are bound to the AES-GCM routine the Subsonic
 * API already uses (#81): its default hasher, scrypt, must never run. Each
 * call costs about 100 ms of CPU against the Free plan's 10 ms.
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

  const app = createApp();
  send = (request) => app.request(request, undefined, testEnv);
  await seedUser("Alice", "wonderland");
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

  it("control: the same spies see scrypt when the hooks are left out", async () => {
    const plain = betterAuth({
      baseURL: ORIGIN,
      basePath: "/api/auth",
      secret: "a-secret-for-the-control-instance-only",
      database: drizzleAdapter(drizzle(testEnv.DB), {
        provider: "sqlite",
        schema: { user, session, account, verification, rateLimit },
      }),
      user: { fields: { email: "authEmail" } },
      emailAndPassword: { enabled: true },
    });

    const context = await plain.$context;
    await context.password.hash("wonderland");

    expect(scryptCalls()).toBe(1);
  });
});
