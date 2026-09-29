import { SELF } from "cloudflare:test";
import { user } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { subsonicToken } from "../src/auth/crypto";
import { database } from "../src/db";
import { findUserByUsername } from "../src/users/repository";
import {
  CookieJar,
  consoleRequest,
  SESSION_DATA_COOKIE,
  SESSION_TOKEN_COOKIE,
  signIn,
} from "./console-auth-support";
import { BASE, type JsonEnvelope, seedUser, testEnv } from "./support";

/**
 * The console's Better Auth routes and `GET /api/me` (#89), through the Worker
 * itself. The first-run bootstrap creates `admin` / `sesame` from the bindings
 * in vitest.config.ts.
 */

const send = (request: Request) => SELF.fetch(request);

beforeAll(async () => {
  // The first request bootstraps the admin, before any other user exists.
  await send(consoleRequest(BASE, "/api/me"));
  await seedUser("Alice", "wonderland", false, "alice@example.com");
  await seedUser("Émile", "zola");
  await seedUser("jo", "short-name");
  await seedUser("DJ Shadow-7", "endtroducing");
});

async function me(jar: CookieJar) {
  const response = await send(consoleRequest(BASE, "/api/me", { jar }));
  jar.absorb(response);

  return { status: response.status, body: await response.json() };
}

describe("sign-in", () => {
  it("signs the first-run admin in, with __Secure- HttpOnly SameSite=Lax cookies", async () => {
    const { response, jar } = await signIn(send, BASE, "admin", "sesame");

    expect(response.status).toBe(200);
    expect(jar.names()).toEqual([SESSION_DATA_COOKIE, SESSION_TOKEN_COOKIE]);
    for (const cookie of response.headers.getSetCookie()) {
      expect(cookie).toMatch(/^__Secure-better-auth\.session_(token|data)=/);
      expect(cookie).toMatch(/; Secure/);
      expect(cookie).toMatch(/; HttpOnly/);
      expect(cookie).toMatch(/; SameSite=Lax/);
      expect(cookie).toMatch(/; Path=\//);
    }
  });

  it("answers with the user as Better Auth maps it, is_admin included", async () => {
    const { response } = await signIn(send, BASE, "Alice", "wonderland");
    const body = (await response.json()) as { user: Record<string, unknown> };

    expect(body.user).toMatchObject({
      name: "Alice",
      email: "alice@users.invalid",
      emailVerified: false,
      image: null,
      username: "alice",
      displayUsername: "Alice",
      isAdmin: false,
    });
  });

  it("matches the name in any ASCII case, as Subsonic's `u` does", async () => {
    for (const spelling of ["Alice", "alice", "ALICE", "aLiCe"]) {
      const { response } = await signIn(send, BASE, spelling, "wonderland");
      expect(response.status, spelling).toBe(200);
    }
  });

  it("folds case exactly as the Subsonic lookup does, ASCII only", async () => {
    // SQLite's lower() leaves "É" alone, so neither side finds "émile".
    expect(await findUserByUsername(database(testEnv), "émile")).toBeNull();
    expect((await signIn(send, BASE, "émile", "zola")).response.status).toBe(401);

    expect((await findUserByUsername(database(testEnv), "ÉMILE"))?.userName).toBe("Émile");
    expect((await signIn(send, BASE, "ÉMILE", "zola")).response.status).toBe(200);
  });

  it("accepts names the username plugin's default rules would refuse", async () => {
    // Its defaults: 3 to 30 characters of [a-zA-Z0-9_.].
    expect((await signIn(send, BASE, "jo", "short-name")).response.status).toBe(200);
    expect((await signIn(send, BASE, "dj shadow-7", "endtroducing")).response.status).toBe(200);
  });

  it("refuses a wrong password and an unknown user alike", async () => {
    const wrong = await signIn(send, BASE, "alice", "looking-glass");
    const unknown = await signIn(send, BASE, "mad-hatter", "tea");

    expect(wrong.response.status).toBe(401);
    expect(unknown.response.status).toBe(401);
    expect(await wrong.response.json()).toEqual(await unknown.response.json());
    expect(wrong.jar.names()).toEqual([]);
  });

  // Better Auth checks the Origin of a POST that carries cookies, which is
  // what a cross-site request riding on a browser's session looks like.
  it("refuses a sign-in posted from another origin", async () => {
    const response = await send(
      consoleRequest(BASE, "/api/auth/sign-in/username", {
        body: { username: "admin", password: "sesame" },
        headers: { origin: "https://evil.example", cookie: "unrelated=1" },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  // Without cookies, the only cross-site POST a browser sends without asking
  // first (a CORS preflight, which /api never grants) is a form: refused.
  it("refuses a sign-in posted as a cross-site form", async () => {
    const response = await send(
      new Request(`${BASE}/api/auth/sign-in/username`, {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "cross-site",
          "cf-connecting-ip": "198.51.100.254",
        },
        body: "username=admin&password=sesame",
      }),
    );

    // Better Auth accepts JSON bodies only.
    expect(response.status).toBe(415);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("never puts the stored password in a response or in the cookie cache", async () => {
    const { response, jar } = await signIn(send, BASE, "Alice", "wonderland");
    const [row] = await database(testEnv)
      .select({ password: user.password })
      .from(user)
      .where(eq(user.userName, "Alice"));
    const session = await send(consoleRequest(BASE, "/api/auth/get-session", { jar }));
    const cached = decodeURIComponent(jar.get(SESSION_DATA_COOKIE) ?? "");
    const decoded = atob(cached.replace(/-/g, "+").replace(/_/g, "/"));

    expect(decoded).toContain('"displayUsername":"Alice"');
    for (const text of [await response.text(), await session.text(), decoded]) {
      expect(text).not.toContain(row?.password);
      expect(text).not.toMatch(/"password"/);
    }
  });
});

describe("the disabled routes", () => {
  it.each([
    "/sign-in/email",
    "/sign-up/email",
    "/update-user",
    "/change-password",
    "/change-email",
    "/delete-user",
    "/request-password-reset",
    "/reset-password",
    "/is-username-available",
  ])("answer POST /api/auth%s with 404", async (path) => {
    const { jar } = await signIn(send, BASE, "admin", "sesame");

    const response = await send(
      consoleRequest(BASE, `/api/auth${path}`, {
        body: {
          email: "admin@users.invalid",
          password: "sesame",
          newPassword: "x",
          currentPassword: "sesame",
          newEmail: "x@example.com",
          name: "x",
          username: "x",
          token: "x",
        },
        jar,
      }),
    );

    expect(response.status).toBe(404);
  });

  it("leave the password where it was", async () => {
    expect((await signIn(send, BASE, "admin", "sesame")).response.status).toBe(200);
  });
});

describe("GET /api/me", () => {
  it("answers who is signed in", async () => {
    const { jar } = await signIn(send, BASE, "ADMIN", "sesame");
    const admin = await findUserByUsername(database(testEnv), "admin");

    expect(await me(jar)).toEqual({
      status: 200,
      body: { id: admin?.id, userName: "admin", isAdmin: true },
    });
  });

  it("answers with the name as stored, whatever case it was signed in with", async () => {
    const { jar } = await signIn(send, BASE, "alice", "wonderland");

    expect((await me(jar)).body).toMatchObject({ userName: "Alice", isAdmin: false });
  });

  it("answers 401 without a session", async () => {
    expect(await me(new CookieJar())).toEqual({
      status: 401,
      body: { error: "unauthenticated" },
    });
  });

  it("answers 401 for a forged session cookie", async () => {
    const jar = new CookieJar();
    jar.absorb(
      new Response(null, {
        headers: { "set-cookie": `${SESSION_TOKEN_COOKIE}=forged.signature; Path=/` },
      }),
    );

    expect((await me(jar)).status).toBe(401);
  });
});

describe("sign-out", () => {
  it("ends the session and clears both cookies", async () => {
    const { jar } = await signIn(send, BASE, "Alice", "wonderland");
    const stale = jar.header();

    const response = await send(consoleRequest(BASE, "/api/auth/sign-out", { body: {}, jar }));
    jar.absorb(response);

    expect(response.status).toBe(200);
    expect(jar.names()).toEqual([]);
    // The token itself no longer names a session; only a cache still inside
    // its 5 minutes would vouch for it, and sign-out cleared that cookie.
    const replay = await send(
      new Request(`${BASE}/api/auth/get-session?disableCookieCache=true`, {
        headers: { cookie: stale },
      }),
    );
    expect(await replay.json()).toBeNull();
  });
});

describe("the Subsonic API", () => {
  it("still answers getUser with the stored name and the Subsonic email", async () => {
    const query = new URLSearchParams({
      u: "ALICE",
      t: await subsonicToken("wonderland", "abc"),
      s: "abc",
      v: "1.16.1",
      c: "test",
      f: "json",
      username: "Alice",
    });
    const response = await SELF.fetch(`${BASE}/rest/getUser?${query}`);
    const body = (await response.json()) as JsonEnvelope;

    expect(body["subsonic-response"]).toMatchObject({
      status: "ok",
      user: { username: "Alice", email: "alice@example.com", adminRole: false },
    });
  });
});
