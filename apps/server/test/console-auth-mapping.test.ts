/**
 * SPIKE #86, questions 1 and 2: Better Auth's user model mapped onto the
 * existing `user` table, and username sign-in through the username plugin.
 */

import { SELF } from "cloudflare:test";
import { user } from "@stratosonic/db";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { subsonicToken } from "../src/auth/crypto";
import type { ConsoleAuth } from "../src/console-auth/auth";
import { database } from "../src/db";
import { findUserByUsername } from "../src/users/repository";
import { authRequest, CookieJar, countedAuth, createUser } from "./console-auth-support";
import { BASE, type JsonEnvelope, testEnv } from "./support";

let auth: ConsoleAuth;

beforeAll(async () => {
  ({ auth } = await countedAuth());
  await createUser("Alice", "wonderland", true);
  await createUser("Émile", "zola");
  await createUser("jo", "short-name");
  await createUser("dj shadow-7", "endtroducing");
});

async function signIn(username: string, password: string, jar = new CookieJar()) {
  const response = await auth.handler(
    authRequest("/sign-in/username", { body: { username, password }, jar }),
  );
  jar.absorb(response);
  return { response, jar };
}

describe("question 1: the user table mapping", () => {
  it("adds only generated or defaulted columns, so no existing column changes", async () => {
    const columns = await testEnv.DB.prepare(
      "SELECT name, type, \"notnull\", dflt_value, hidden FROM pragma_table_xinfo('user')",
    ).all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      hidden: number;
    }>();

    // hidden = 2 marks a VIRTUAL generated column: stored nowhere, written by no one.
    expect(columns.results).toEqual([
      { name: "id", type: "TEXT", notnull: 1, dflt_value: null, hidden: 0 },
      { name: "user_name", type: "TEXT", notnull: 1, dflt_value: null, hidden: 0 },
      { name: "name", type: "TEXT", notnull: 1, dflt_value: "''", hidden: 0 },
      { name: "email", type: "TEXT", notnull: 1, dflt_value: "''", hidden: 0 },
      { name: "password", type: "TEXT", notnull: 1, dflt_value: "''", hidden: 0 },
      { name: "is_admin", type: "INTEGER", notnull: 1, dflt_value: "false", hidden: 0 },
      { name: "token_epoch", type: "INTEGER", notnull: 1, dflt_value: "0", hidden: 0 },
      { name: "last_login_at", type: "INTEGER", notnull: 0, dflt_value: null, hidden: 0 },
      { name: "last_access_at", type: "INTEGER", notnull: 0, dflt_value: null, hidden: 0 },
      { name: "created_at", type: "INTEGER", notnull: 1, dflt_value: null, hidden: 0 },
      { name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: null, hidden: 0 },
      { name: "username", type: "TEXT", notnull: 0, dflt_value: null, hidden: 2 },
      { name: "auth_email", type: "TEXT", notnull: 0, dflt_value: null, hidden: 2 },
      { name: "email_verified", type: "INTEGER", notnull: 1, dflt_value: "false", hidden: 0 },
      { name: "image", type: "TEXT", notnull: 0, dflt_value: null, hidden: 0 },
    ]);
  });

  it("derives the username and placeholder email from user_name", async () => {
    const [row] = await database(testEnv)
      .select({ username: user.username, authEmail: user.authEmail, userName: user.userName })
      .from(user)
      .where(eq(user.userName, "Alice"));

    expect(row).toEqual({
      userName: "Alice",
      username: "alice",
      authEmail: "alice@users.invalid",
    });
  });

  it("follows a rename without a second write", async () => {
    const db = database(testEnv);
    await db.update(user).set({ userName: "Jo" }).where(eq(user.userName, "jo"));
    const [row] = await db
      .select({ username: user.username, authEmail: user.authEmail })
      .from(user)
      .where(eq(user.userName, "Jo"));
    await db.update(user).set({ userName: "jo" }).where(eq(user.userName, "Jo"));

    expect(row).toEqual({ username: "jo", authEmail: "jo@users.invalid" });
  });

  it("serves the plugin's lookup from an index", async () => {
    const plan = await testEnv.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM user WHERE username = ?",
    )
      .bind("alice")
      .all<{ detail: string }>();

    expect(plan.results.map((row) => row.detail).join("\n")).toMatch(
      /USING INDEX user_username_unique/,
    );
  });

  it("returns the session user from the mapped columns, with is_admin read-only", async () => {
    const { response } = await signIn("Alice", "wonderland");
    const body = (await response.json()) as { user: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(body.user).toMatchObject({
      name: "Alice",
      email: "alice@users.invalid",
      emailVerified: false,
      image: null,
      username: "alice",
      displayUsername: "Alice",
      isAdmin: true,
    });
  });

  it("never puts the stored password in a response or in the cookie cache", async () => {
    const { response, jar } = await signIn("Alice", "wonderland");
    const [row] = await database(testEnv)
      .select({ password: user.password })
      .from(user)
      .where(eq(user.userName, "Alice"));
    const signInBody = await response.text();

    const session = await auth.handler(authRequest("/get-session", { jar }));
    const sessionBody = await session.text();
    const cached = jar.get("__Secure-better-auth.session_data") ?? "";
    const decoded = atob(decodeURIComponent(cached).replace(/-/g, "+").replace(/_/g, "/"));

    for (const text of [signInBody, sessionBody, decoded]) {
      expect(text).not.toContain(row.password);
      expect(text).not.toMatch(/"password"/);
    }
    expect(decoded).toContain('"displayUsername":"Alice"');
  });

  it("leaves what the Subsonic API sees unchanged", async () => {
    const query = new URLSearchParams({
      u: "ALICE",
      t: await subsonicToken("wonderland", "abc"),
      s: "abc",
      v: "1.16.1",
      c: "spike",
      f: "json",
      username: "Alice",
    });
    const response = await SELF.fetch(`${BASE}/rest/getUser?${query}`);
    const body = (await response.json()) as JsonEnvelope;

    expect(body["subsonic-response"]).toMatchObject({
      status: "ok",
      user: { username: "Alice", adminRole: true },
    });
    expect(body["subsonic-response"].user).not.toHaveProperty("email");
  });
});

describe("question 2: username sign-in", () => {
  it("matches the name in any ASCII case, as Subsonic's `u` does", async () => {
    for (const spelling of ["Alice", "alice", "ALICE", "aLiCe"]) {
      const { response } = await signIn(spelling, "wonderland");
      expect(response.status, spelling).toBe(200);
    }
  });

  it("folds case exactly as the Subsonic lookup does, ASCII only", async () => {
    const db = database(testEnv);
    // SQLite's lower() leaves 'É' alone, so neither side finds "émile".
    expect(await findUserByUsername(db, "émile")).toBeNull();
    expect((await signIn("émile", "zola")).response.status).toBe(401);

    expect((await findUserByUsername(db, "ÉMILE"))?.userName).toBe("Émile");
    expect((await signIn("ÉMILE", "zola")).response.status).toBe(200);
  });

  it("accepts names the plugin's default rules would refuse", async () => {
    // Defaults: 3..30 characters of [a-zA-Z0-9_.].
    expect((await signIn("jo", "short-name")).response.status).toBe(200);
    expect((await signIn("DJ Shadow-7", "endtroducing")).response.status).toBe(200);
  });

  it("refuses a wrong password and an unknown user alike", async () => {
    const wrong = await signIn("alice", "looking-glass");
    const unknown = await signIn("mad-hatter", "tea");

    expect(wrong.response.status).toBe(401);
    expect(unknown.response.status).toBe(401);
    expect(await wrong.response.json()).toEqual(await unknown.response.json());
  });

  it("keeps sign-in by the placeholder email switched off", async () => {
    const response = await auth.handler(
      authRequest("/sign-in/email", {
        body: { email: "alice@users.invalid", password: "wonderland" },
      }),
    );

    expect(response.status).toBe(404);
  });

  it("stores nothing through the plugin: user_name keeps its case", async () => {
    const rows = await database(testEnv)
      .select({ userName: user.userName })
      .from(user)
      .where(sql`lower(${user.userName}) = 'alice'`);

    expect(rows).toEqual([{ userName: "Alice" }]);
  });
});
