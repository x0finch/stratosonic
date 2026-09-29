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

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { createApiApp } from "../src/api/app";
import { createUserWithPassword, setPassword } from "../src/console-auth/credentials";
import { database } from "../src/db";
import type { Env } from "../src/env";

const MIGRATIONS = new URL("../../../packages/db/migrations/", import.meta.url);
const PASSPHRASE = "bench-password-encryption-key";
const SETUP_TOKEN = "bench-setup-token-0123456789abcdef0123456789abcdef";
const ORIGIN = "https://stratosonic.bench";
const WARM_UP = 20;

// Better Auth logs every failed sign-in, which the wrong-password run makes
// by the hundred.
console.warn = () => {};

/* --------------------------------------------- a D1 stand-in, timed -- */

let d1Ms = 0;
let d1Statements = 0;

function timed<T>(work: () => T): T {
  const start = performance.now();
  try {
    return work();
  } finally {
    d1Ms += performance.now() - start;
    d1Statements++;
  }
}

type Param = null | number | bigint | string | Uint8Array;

function toParam(value: unknown): Param {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as Param;
}

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: Param[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new Statement(this.db, this.sql, values.map(toParam));
  }

  private execute() {
    const statement = this.db.prepare(this.sql);
    if (/^\s*(select|with|pragma)|\breturning\b/i.test(this.sql)) {
      return { rows: statement.all(...this.params) as Record<string, unknown>[], changes: 0 };
    }
    const result = statement.run(...this.params);
    return { rows: [] as Record<string, unknown>[], changes: Number(result.changes) };
  }

  async all() {
    const { rows, changes } = timed(() => this.execute());
    return { results: rows, success: true, meta: { changes } };
  }

  async run() {
    return this.all();
  }

  async first(column?: string) {
    const { rows } = timed(() => this.execute());
    const row = rows[0] ?? null;
    return column === undefined ? row : (row?.[column] ?? null);
  }

  async raw() {
    const { rows } = timed(() => this.execute());
    return rows.map((row) => Object.values(row));
  }
}

function fakeD1(db: DatabaseSync): D1Database {
  const binding = {
    prepare: (sql: string) => new Statement(db, sql),
    async batch(statements: Statement[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) {
          results.push(await statement.all());
        }
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };

  return binding as unknown as D1Database;
}

const sqlite = new DatabaseSync(":memory:");
for (const file of readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith(".sql"))
  .sort()) {
  for (const statement of readFileSync(new URL(file, MIGRATIONS), "utf8").split(
    "--> statement-breakpoint",
  )) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

const DB = fakeD1(sqlite);
const env = { DB, PASSWORD_ENCRYPTION_KEY: PASSPHRASE, SETUP_TOKEN } as unknown as Env;
const db = database(env);

/* ------------------------------------------------------------ requests -- */

/** The Worker's `/api` mount, as src/app.ts makes it. */
function worker() {
  const app = new Hono<{ Bindings: Env }>().route("/api", createApiApp());
  return (request: Request) => app.request(request, undefined, env);
}

let address = 0;

function request(path: string, init: { body?: unknown; cookie?: string; origin?: string } = {}) {
  address++;
  const origin = init.origin ?? ORIGIN;
  const headers = new Headers({
    origin,
    "cf-connecting-ip": `10.${(address >> 16) & 255}.${(address >> 8) & 255}.${address & 255}`,
  });
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);

  return new Request(`${origin}${path}`, {
    method: init.body === undefined ? "GET" : "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/* ------------------------------------------------------- measurement -- */

interface Sample {
  readonly js: number;
  readonly statements: number;
}

async function sample(work: () => Promise<unknown>): Promise<Sample> {
  const d1Before = d1Ms;
  const statementsBefore = d1Statements;
  const start = performance.now();
  await work();
  return {
    js: performance.now() - start - (d1Ms - d1Before),
    statements: d1Statements - statementsBefore,
  };
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

const results: Record<string, string | number>[] = [];

/**
 * Times `n` runs of what `prepare` returns, after a warm-up; `prepare` itself
 * (a sign-in to sign out, say) is not timed.
 */
async function bench(label: string, n: number, prepare: () => Promise<() => Promise<unknown>>) {
  const samples: Sample[] = [];
  for (let index = 0; index < n + WARM_UP; index++) {
    const measured = await sample(await prepare());
    if (index >= WARM_UP) samples.push(measured);
  }
  const js = samples.map((s) => s.js);
  results.push({
    operation: label,
    n,
    "p50 ms": percentile(js, 50).toFixed(2),
    "p95 ms": percentile(js, 95).toFixed(2),
    "D1 stmts": samples[0]?.statements ?? 0,
  });
}

const aliceId = await createUserWithPassword(db, PASSPHRASE, {
  userName: "Alice",
  password: "wonderland",
  isAdmin: true,
});
if (aliceId === null) throw new Error("could not create the bench user");

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
  "setPassword (one batch)",
  300,
  async () => () => setPassword(db, PASSPHRASE, aliceId, "wonderland"),
);
let user = 0;
await bench("createUserWithPassword (one batch)", 300, async () => {
  const userName = `user-${user++}`;
  return () => createUserWithPassword(db, PASSPHRASE, { userName, password: "x", isAdmin: false });
});

/** Fails the bench when a request is not answered as it should be. */
async function expecting(status: number, response: Promise<Response>): Promise<void> {
  const answered = await response;
  if (answered.status !== status) {
    throw new Error(`${answered.url} answered ${answered.status}, not ${status}`);
  }
}

// Setup, recovery and the password change (#90). Recovery needs the token
// unspent, so each run forgets it first, untimed.
await bench(
  "GET /api/setup (reset-available)",
  1000,
  async () => () => expecting(200, send(request("/api/setup"))),
);
await bench("POST /api/setup/reset", 300, async () => {
  sqlite.exec("DELETE FROM property WHERE id LIKE 'SetupTokenSpent:%'");
  return () =>
    expecting(
      200,
      send(
        request("/api/setup/reset", {
          body: { token: SETUP_TOKEN, username: "alice", password: "wonderland" },
        }),
      ),
    );
});
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
// Each run forgets the failures counted so far, untimed, or the limit on
// them would answer 429 from the sixth on.
await bench("POST /api/account/password, wrong current password", 300, async () => {
  sqlite.exec("DELETE FROM rate_limit WHERE key LIKE 'account-password:%'");
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
// Last, since each run empties the user table first, untimed.
await bench("POST /api/setup (first admin)", 300, async () => {
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

console.log(`node ${process.version}, ${process.arch}`);
console.table(results);
