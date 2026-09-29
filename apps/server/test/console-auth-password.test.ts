/**
 * SPIKE #86, question 3: Better Auth's password hooks bound to the AES-GCM
 * routine the Subsonic side already uses, with scrypt instrumented to prove it
 * never runs - and a control proving the instrument would have seen it.
 */

import { SELF } from "cloudflare:test";
import { account, user } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptPassword, subsonicToken } from "../src/auth/crypto";
import { setPasswordAndRevokeSessions } from "../src/console-auth/credentials";
import { database } from "../src/db";
import { authRequest, CookieJar, countedAuth, createUser } from "./console-auth-support";
import { scryptProbe } from "./scrypt-probe";
import { BASE, encryptionKey, type JsonEnvelope, testEnv } from "./support";

// Better Auth's default hasher is `@better-auth/utils/password`, whose
// `workerd` build runs `node:crypto`'s scrypt. Under test that module is
// aliased to a probe that counts each call and forwards to the real one
// (vitest.config.ts, test/scrypt-probe.ts).
const scryptCalls = {
  get count() {
    return scryptProbe.calls;
  },
  set count(value: number) {
    scryptProbe.calls = value;
  },
};

let aliceId: string;

beforeAll(async () => {
  aliceId = await createUser("Alice", "wonderland");
});

async function signIn(
  auth: { handler: (request: Request) => Promise<Response> },
  username: string,
  password: string,
) {
  const jar = new CookieJar();
  const response = await auth.handler(
    authRequest("/sign-in/username", { body: { username, password } }),
  );
  jar.absorb(response);
  return { response, jar };
}

async function subsonicPing(userName: string, password: string) {
  const query = new URLSearchParams({
    u: userName,
    t: await subsonicToken(password, "salt"),
    s: "salt",
    v: "1.16.1",
    c: "spike",
    f: "json",
  });
  const response = await SELF.fetch(`${BASE}/rest/ping?${query}`);
  return ((await response.json()) as JsonEnvelope)["subsonic-response"].status;
}

describe("question 3: password hooks", () => {
  it("signs in through the AES-GCM hooks without ever running scrypt", async () => {
    const { auth } = await countedAuth();
    scryptCalls.count = 0;

    const good = await signIn(auth, "alice", "wonderland");
    const bad = await signIn(auth, "alice", "wrong");
    const unknown = await signIn(auth, "nobody", "whatever");

    expect([good.response.status, bad.response.status, unknown.response.status]).toEqual([
      200, 401, 401,
    ]);
    expect(scryptCalls.count).toBe(0);
  });

  it("control: the same instrument sees scrypt when the hooks are left out", async () => {
    const { auth } = await countedAuth({ usePasswordHooks: false });
    const context = await auth.$context;
    scryptCalls.count = 0;

    console.log("DIAG", context.password.hash.toString().slice(0, 300));
    const hash = await context.password.hash("wonderland");
    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(scryptCalls.count).toBe(1);

    // The unknown-user path of sign-in hashes too, to even out timing.
    await signIn(auth, "nobody", "whatever");
    expect(scryptCalls.count).toBe(2);
  });

  it("hands verify only the account's stored value and the attempt", async () => {
    const { auth } = await countedAuth();
    const context = await auth.$context;
    const original = context.password.verify;
    const seen: unknown[] = [];
    context.password.verify = async (input) => {
      seen.push(input);
      return original(input);
    };

    await signIn(auth, "alice", "wonderland");
    context.password.verify = original;

    const [row] = await database(testEnv)
      .select({ password: account.password })
      .from(account)
      .where(eq(account.userId, aliceId));
    // No user id, no user row: a verify that wanted `user.password` instead
    // would have to smuggle the id through `account.password`.
    expect(seen).toEqual([{ hash: row.password, password: "wonderland" }]);
  });

  it("keeps user.password and account.password equal through a password change", async () => {
    const db = database(testEnv);
    await setPasswordAndRevokeSessions(db, encryptionKey(), aliceId, "looking-glass");

    const [userRow] = await db
      .select({ password: user.password, tokenEpoch: user.tokenEpoch })
      .from(user)
      .where(eq(user.id, aliceId));
    const [accountRow] = await db
      .select({ password: account.password })
      .from(account)
      .where(eq(account.userId, aliceId));

    expect(accountRow.password).toBe(userRow.password);
    expect(await decryptPassword(encryptionKey(), userRow.password)).toBe("looking-glass");
    expect(userRow.tokenEpoch).toBe(1);

    const { auth } = await countedAuth();
    expect((await signIn(auth, "Alice", "looking-glass")).response.status).toBe(200);
    expect((await signIn(auth, "Alice", "wonderland")).response.status).toBe(401);
    expect(await subsonicPing("Alice", "looking-glass")).toBe("ok");
    expect(await subsonicPing("Alice", "wonderland")).toBe("failed");
  });
});
