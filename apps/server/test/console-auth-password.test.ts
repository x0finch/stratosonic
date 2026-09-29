import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import * as scrypt from "@better-auth/utils/password";
import { account, rateLimit, session, user, verification } from "@stratosonic/db";
import { betterAuth } from "better-auth/minimal";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { consoleRequest, signIn } from "./console-auth-support";
import { seedUser, testEnv } from "./support";

/**
 * Better Auth's password hooks are bound to the AES-GCM routine the Subsonic
 * API already uses (#81): its default hasher, scrypt, must never run. Each
 * call costs about 100 ms of CPU against the Free plan's 10 ms.
 *
 * The default hasher is `@better-auth/utils/password`, whose `workerd` build
 * runs `node:crypto`'s scrypt. It is replaced here by spies that forward to the
 * real functions; the Workers pool loads Better Auth through Vitest's module
 * graph, so its own import of the hasher gets the spies too. (It is a
 * devDependency so that this file can name it.) A control proves the spies see
 * scrypt when the hooks are left out.
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
const app = createApp();
const send = (request: Request) => app.request(request, undefined, testEnv);

function scryptCalls(): number {
  return (
    vi.mocked(scrypt.hashPassword).mock.calls.length +
    vi.mocked(scrypt.verifyPassword).mock.calls.length
  );
}

beforeAll(async () => {
  await seedUser("Alice", "wonderland");
  await send(consoleRequest(ORIGIN, "/api/me"));
}, 30_000);

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
