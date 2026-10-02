/**
 * CPU per request of the admin console's auth paths (#81, "Free-tier budget").
 *
 *   pnpm --filter @stratosonic/server bench:console-auth
 *
 * Not part of the test suite or CI: it takes a minute and its numbers depend
 * on the machine. Re-run it when Better Auth, its configuration or the
 * console's middleware changes, and compare with the table in the PR that
 * made the change. The startup side is measured by bench-startup.mjs.
 *
 * Why Node rather than workerd: workerd does not advance `Date.now()` or
 * `performance.now()` while JavaScript runs, so CPU cannot be timed inside a
 * Worker. This runs the same modules - the `/api` sub-app, its middleware,
 * Better Auth and the Drizzle D1 driver - over a stand-in for D1 built on
 * `node:sqlite`, and reports the time spent outside the stand-in: on Workers,
 * D1 executes on its own machine and the Worker only waits for it. p95 carries
 * the machine's noise and GC, so read p50 as the estimate and confirm on the
 * edge with Workers Observability (`cpuTime`).
 *
 * "D1 stmts" is the number of statements each request sends; the rows they
 * read and write are counted by D1 itself in test/console-auth-sessions.test.ts,
 * test/setup-token.test.ts and test/account-password.test.ts.
 * The first row is the first `/api` request of an isolate less the evaluation
 * of the Better Auth modules, which happens at startup: building the instance
 * and serving the request.
 */

import { Hono } from "hono";
import { createApiApp } from "../src/api/app";
import { createConsoleUser, setConsolePassword } from "../src/console-auth/credentials";
import { hashConsolePassword, verifyConsolePassword } from "../src/console-auth/password-hash";
import type { Role } from "../src/console-auth/permissions";
import { database } from "../src/db";
import type { Env } from "../src/env";
import { apiRequest, bench, cookieHeader, expecting, migratedD1, report } from "./bench-support";

const PASSPHRASE = "bench-password-encryption-key";
const SETUP_TOKEN = "bench-setup-token-0123456789abcdef0123456789abcdef";
const ORIGIN = "https://stratosonic.bench";

// Better Auth logs every failed sign-in, which the wrong-password run makes
// by the hundred.
console.warn = () => {};

const { sqlite, DB } = migratedD1();
const env = { DB, PASSWORD_ENCRYPTION_KEY: PASSPHRASE, SETUP_TOKEN } as unknown as Env;
const db = database(env);

/* ------------------------------------------------------------ requests -- */

/** The Worker's `/api` mount, as src/app.ts makes it. */
function worker() {
  const app = new Hono<{ Bindings: Env }>().route("/api", createApiApp());
  return (request: Request) => app.request(request, undefined, env);
}

function request(path: string, init: { body?: unknown; cookie?: string; origin?: string } = {}) {
  return apiRequest(init.origin ?? ORIGIN, path, init);
}

/* ------------------------------------------------------- measurement -- */

// The console's password hash itself (ADR-0007): what sign-in's verify hook
// and every password write pay, outside any request.
const stored = await hashConsolePassword(PASSPHRASE, "wonderland");
await bench(
  "hashConsolePassword (HMAC-SHA256)",
  2000,
  async () => () => hashConsolePassword(PASSPHRASE, "wonderland"),
);
await bench(
  "verifyConsolePassword (HMAC-SHA256)",
  2000,
  async () => () => verifyConsolePassword(PASSPHRASE, stored, "wonderland"),
);
await bench(
  "hashConsolePassword, 1,024-character password",
  2000,
  async () => () => hashConsolePassword(PASSPHRASE, "p".repeat(1024)),
);

const aliceId = await createConsoleUser(db, PASSPHRASE, {
  username: "Alice",
  password: "wonderland",
  role: "owner",
});
if (aliceId === null) throw new Error("could not create the bench's owner");

// A fresh app and origin each time, so the isolate's instance cache misses.
let freshOrigin = 0;
await bench("first /api request of an isolate (build + GET /api/me)", 50, async () => {
  const send = worker();
  const origin = `https://fresh-${freshOrigin++}.bench`;
  return () => send(request("/api/me", { origin }));
});

const send = worker();
await send(request("/api/me"));

async function signIn(): Promise<string> {
  const response = await send(
    request("/api/auth/sign-in/username", { body: { username: "alice", password: "wonderland" } }),
  );
  if (response.status !== 200) throw new Error(`sign-in answered ${response.status}`);
  return cookieHeader(response);
}

await bench("sign-in", 300, async () => signIn);
await bench(
  "sign-in, wrong password",
  300,
  async () => () =>
    send(request("/api/auth/sign-in/username", { body: { username: "alice", password: "no" } })),
);

const cookie = await signIn();
await bench(
  "GET /api/me, cookie cache hit (requireSession)",
  2000,
  async () => () => send(request("/api/me", { cookie })),
);
await bench(
  "GET /api/auth/get-session, cookie cache hit",
  2000,
  async () => () => send(request("/api/auth/get-session", { cookie })),
);

// Without the cached copy the check reads D1, as after the cache's 5 minutes
// and as `requireFreshSession` always does.
const tokenOnly = cookie
  .split("; ")
  .filter((pair) => pair.includes("session_token"))
  .join("; ");
await bench(
  "GET /api/me, cache expired (session + user read)",
  1000,
  async () => () => send(request("/api/me", { cookie: tokenOnly })),
);

await bench("sign-out", 300, async () => {
  const signedIn = await signIn();
  return () => send(request("/api/auth/sign-out", { body: {}, cookie: signedIn }));
});

await bench(
  "setConsolePassword (one batch)",
  300,
  async () => () => setConsolePassword(db, PASSPHRASE, aliceId, "wonderland"),
);
let users = 0;
await bench("createConsoleUser (one batch)", 300, async () => {
  const username = `user-${users++}`;
  // A role no release defines: the database takes one owner, and Alice is it.
  return () =>
    createConsoleUser(db, PASSPHRASE, { username, password: "x", role: "guest" as Role });
});

// The setup state and the password change (#90). Setup itself is last.
await bench(
  "GET /api/setup (closed)",
  1000,
  async () => () => expecting(200, send(request("/api/setup"))),
);
await bench("POST /api/account/password", 300, async () => {
  const signedIn = await signIn();
  return () =>
    expecting(
      200,
      send(
        request("/api/account/password", {
          body: { currentPassword: "wonderland", newPassword: "wonderland" },
          cookie: signedIn,
        }),
      ),
    );
});
// Attempts are counted per session, and each run signs in afresh, so the
// limit never answers 429 here.
await bench("POST /api/account/password, wrong current password", 300, async () => {
  const signedIn = await signIn();
  return () =>
    expecting(
      400,
      send(
        request("/api/account/password", {
          body: { currentPassword: "no", newPassword: "wonderland" },
          cookie: signedIn,
        }),
      ),
    );
});
// Last, since each run empties the console's user tables first, untimed.
await bench("POST /api/setup (the owner)", 300, async () => {
  sqlite.exec("DELETE FROM session; DELETE FROM account; DELETE FROM user; DELETE FROM property");
  return () =>
    expecting(
      201,
      send(
        request("/api/setup", {
          body: { token: SETUP_TOKEN, username: "owner", password: "correct horse" },
        }),
      ),
    );
});

report();
