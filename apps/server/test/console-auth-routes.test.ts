import { SELF } from "cloudflare:test";
import { operatorAccount } from "@stratosonic/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { CONSOLE_AUTH_ROUTES, consoleAuth, DISABLED_AUTH_PATHS } from "../src/console-auth/auth";
import { MAX_PASSWORD_LENGTH } from "../src/console-auth/credentials";
import { database } from "../src/db";
import {
  CookieJar,
  consoleRequest,
  SESSION_DATA_COOKIE,
  SESSION_TOKEN_COOKIE,
  seedOperator,
  signIn,
  subsonicPing,
} from "./console-auth-support";
import { BASE, encryptionKey, seedUser, testEnv } from "./support";

/**
 * The console's Better Auth routes and `GET /api/me` (#89, #99), through the
 * Worker itself. They sign operators in, the console's own accounts, and no
 * Subsonic user: the first-run bootstrap creates the Subsonic admin `admin` /
 * `sesame` from the bindings in vitest.config.ts, and an operator named
 * `admin` has a password of its own.
 */

const send = (request: Request) => SELF.fetch(request);

/** The console password of the operator named `admin`. */
const OPERATOR_PASSWORD = "operator's own";

let adminId: string;
let aliceId: string;

beforeAll(async () => {
  // The first request bootstraps the Subsonic admin.
  await send(consoleRequest(BASE, "/api/me"));
  await seedUser("listener", "music");
  adminId = await seedOperator("admin", OPERATOR_PASSWORD);
  aliceId = await seedOperator("Alice", "wonderland");
  await seedOperator("Émile", "zola");
  await seedOperator("jo", "short-name");
  await seedOperator("DJ Shadow-7", "endtroducing");
});

async function me(jar: CookieJar) {
  const response = await send(consoleRequest(BASE, "/api/me", { jar }));
  jar.absorb(response);

  return { status: response.status, body: await response.json() };
}

describe("sign-in", () => {
  it("signs an operator in, with __Secure- HttpOnly SameSite=Lax cookies", async () => {
    const { response, jar } = await signIn(send, BASE, "admin", OPERATOR_PASSWORD);

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

  it("answers with the operator as Better Auth maps it, and no role", async () => {
    const { response } = await signIn(send, BASE, "Alice", "wonderland");
    const body = (await response.json()) as { user: Record<string, unknown> };

    expect(body.user).toMatchObject({
      id: aliceId,
      name: "Alice",
      email: "alice@console.invalid",
      emailVerified: false,
      image: null,
      username: "alice",
      displayUsername: "Alice",
    });
    expect(body.user).not.toHaveProperty("isAdmin");
  });

  it("refuses a Subsonic user's credentials, even for an operator's namesake", async () => {
    const namesake = await signIn(send, BASE, "admin", "sesame");
    const subsonicOnly = await signIn(send, BASE, "listener", "music");

    expect(namesake.response.status).toBe(401);
    expect(subsonicOnly.response.status).toBe(401);
    expect(await namesake.response.json()).toEqual(await subsonicOnly.response.json());
    expect([...namesake.jar.names(), ...subsonicOnly.jar.names()]).toEqual([]);
  });

  it("matches the name in any ASCII case", async () => {
    for (const spelling of ["Alice", "alice", "ALICE", "aLiCe"]) {
      const { response } = await signIn(send, BASE, spelling, "wonderland");
      expect(response.status, spelling).toBe(200);
    }
  });

  it("folds case exactly as the generated `username` column does, ASCII only", async () => {
    // SQLite's lower() leaves "É" alone, so "émile" names nobody.
    expect((await signIn(send, BASE, "émile", "zola")).response.status).toBe(401);
    expect((await signIn(send, BASE, "ÉMILE", "zola")).response.status).toBe(200);
  });

  it("accepts a password of up to MAX_PASSWORD_LENGTH characters, not Better Auth's 128", async () => {
    const longest = "p".repeat(MAX_PASSWORD_LENGTH);
    await seedOperator("Verbose", longest);

    expect((await signIn(send, BASE, "verbose", longest)).response.status).toBe(200);
    const tooLong = await signIn(send, BASE, "verbose", `${longest}p`);
    expect(tooLong.response.status).toBe(400);
    expect(await tooLong.response.json()).toMatchObject({ code: "PASSWORD_TOO_LONG" });
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
        body: { username: "admin", password: OPERATOR_PASSWORD },
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
        body: `username=admin&password=${encodeURIComponent(OPERATOR_PASSWORD)}`,
      }),
    );

    // Better Auth accepts JSON bodies only.
    expect(response.status).toBe(415);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("never puts the stored password in a response or in the cookie cache", async () => {
    const { response, jar } = await signIn(send, BASE, "Alice", "wonderland");
    const [row] = await database(testEnv)
      .select({ password: operatorAccount.password })
      .from(operatorAccount)
      .where(eq(operatorAccount.userId, aliceId));
    const session = await send(consoleRequest(BASE, "/api/auth/get-session", { jar }));
    const cached = decodeURIComponent(jar.get(SESSION_DATA_COOKIE) ?? "");
    const decoded = atob(cached.replace(/-/g, "+").replace(/_/g, "/"));

    expect(decoded).toContain('"displayUsername":"Alice"');
    for (const text of [await response.text(), await session.text(), decoded]) {
      expect(text).not.toContain(row?.password ?? "hmac-sha256$");
      expect(text).not.toMatch(/"password"/);
    }
  });
});

describe("the Better Auth routes", () => {
  const allowed = new Set<string>(CONSOLE_AUTH_ROUTES.map((route) => route.path));
  const disabled = new Set<string>(DISABLED_AUTH_PATHS);

  /** Every route the built instance registers, with the methods it takes. */
  async function registered(): Promise<{ path: string; methods: string[] }[]> {
    const auth = await consoleAuth({ db: testEnv.DB, passphrase: encryptionKey(), origin: BASE });
    return Object.values(auth.api).flatMap((endpoint) => {
      const { path, options } = endpoint as { path?: string; options?: { method?: unknown } };
      if (path === undefined) {
        // Server-only (`setPassword`): callable from our code, never routed.
        return [];
      }
      const method = options?.method;
      return [{ path, methods: Array.isArray(method) ? method : [String(method)] }];
    });
  }

  /** A request path for a route, its parameters filled in. */
  const concrete = (path: string) => `/api/auth${path.replace(/:\w+/g, "x")}`;

  it("are each either used by the console or disabled, so an upgrade's new route fails here", async () => {
    const paths = (await registered()).map((route) => route.path).sort();

    expect(paths.filter((path) => !allowed.has(path) && !disabled.has(path))).toEqual([]);
    // And neither list names a route that no longer exists.
    expect([...allowed, ...disabled].sort()).toEqual(paths);
  });

  it("answer 404 over HTTP for every route and method the console does not use", async () => {
    const { jar } = await signIn(send, BASE, "admin", OPERATOR_PASSWORD);
    const refused: string[] = [];

    for (const { path, methods } of await registered()) {
      for (const method of ["GET", "POST"]) {
        const used = CONSOLE_AUTH_ROUTES.some(
          (route) => route.path === path && route.method === method,
        );
        if (used || !methods.includes(method)) {
          continue;
        }
        const response = await send(
          consoleRequest(BASE, concrete(path), {
            method,
            body: method === "POST" ? { password: OPERATOR_PASSWORD, token: "x" } : undefined,
            jar,
          }),
        );
        if (response.status !== 404) {
          refused.push(`${method} ${path}: ${response.status}`);
        }
      }
    }

    expect(refused).toEqual([]);
  });

  it("are refused by Better Auth itself too, but for the paths with a parameter", async () => {
    const auth = await consoleAuth({ db: testEnv.DB, passphrase: encryptionKey(), origin: BASE });

    for (const path of DISABLED_AUTH_PATHS.filter((path) => !path.includes(":"))) {
      const response = await auth.handler(consoleRequest(BASE, concrete(path), { body: {} }));
      expect(response.status, path).toBe(404);
    }
  });

  it("leave the console's own three reachable", async () => {
    const { response, jar } = await signIn(send, BASE, "admin", OPERATOR_PASSWORD);
    const session = await send(consoleRequest(BASE, "/api/auth/get-session", { jar }));
    const signOut = await send(consoleRequest(BASE, "/api/auth/sign-out", { body: {}, jar }));

    expect([response.status, session.status, signOut.status]).toEqual([200, 200, 200]);
  });
});

describe("GET /api/me", () => {
  it("answers which operator is signed in, and nothing more", async () => {
    const { jar } = await signIn(send, BASE, "ADMIN", OPERATOR_PASSWORD);

    expect(await me(jar)).toEqual({ status: 200, body: { id: adminId, username: "admin" } });
  });

  it("answers with the name as stored, whatever case it was signed in with", async () => {
    const { jar } = await signIn(send, BASE, "alice", "wonderland");

    expect((await me(jar)).body).toEqual({ id: aliceId, username: "Alice" });
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
  it("refuses every operator's credentials with error 40, by token and by p=", async () => {
    expect(await subsonicPing(send, BASE, "admin", OPERATOR_PASSWORD)).toBe(40);
    expect(await subsonicPing(send, BASE, "alice", "wonderland")).toBe(40);
  });

  it("still signs its own users in, an operator's namesake too", async () => {
    expect(await subsonicPing(send, BASE, "admin", "sesame")).toBe("ok");
    expect(await subsonicPing(send, BASE, "listener", "music")).toBe("ok");
  });
});
